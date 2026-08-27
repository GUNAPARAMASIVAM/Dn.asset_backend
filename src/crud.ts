import { PrismaClient, Lead, PropertyValuation } from '@prisma/client';
import { PropertyEstimateCreate, LeadCreate, LeadUpdate, UploadRefSchema } from './schemas';
import { ValuationResult } from './valuation_service';

export const prisma = new PrismaClient();

const DUPLICATE_WINDOW_MINUTES = parseInt(process.env.DN_ASSET_DUPLICATE_WINDOW_MINUTES || "10", 10);
const LEAD_PREFIX = "DNA";
const VALUATION_PREFIX = "VAL";

// --------------------------------------------------------------------------
// Lead reference : DNA-YYYYMMDD-XXXX
// --------------------------------------------------------------------------
async function next_reference(model: any, prefix: string, when: Date = new Date()): Promise<string> {
    const dateStr = when.toISOString().split('T')[0].replace(/-/g, '');
    const stem = `${prefix}-${dateStr}-`;

    let lastRecord;
    if (prefix === LEAD_PREFIX) {
        lastRecord = await model.findFirst({
            where: { lead_reference: { startsWith: stem } },
            orderBy: { lead_reference: 'desc' }
        });
    } else {
        lastRecord = await model.findFirst({
            where: { valuation_reference: { startsWith: stem } },
            orderBy: { valuation_reference: 'desc' }
        });
    }

    let sequence = 1;
    if (lastRecord) {
        const ref = prefix === LEAD_PREFIX ? lastRecord.lead_reference : lastRecord.valuation_reference;
        const parts = ref.split('-');
        if (parts.length > 2) {
            sequence = parseInt(parts[2], 10) + 1;
        }
    }
    
    return `${stem}${sequence.toString().padStart(4, '0')}`;
}

export async function generate_lead_reference(when?: Date): Promise<string> {
    return next_reference(prisma.lead, LEAD_PREFIX, when);
}

export async function generate_valuation_reference(when?: Date): Promise<string> {
    return next_reference(prisma.propertyValuation, VALUATION_PREFIX, when);
}

// --------------------------------------------------------------------------
// Create
// --------------------------------------------------------------------------
export async function find_recent_duplicate(phone: string, main_service: string): Promise<Lead | null> {
    const cutoff = new Date(Date.now() - DUPLICATE_WINDOW_MINUTES * 60000);
    return prisma.lead.findFirst({
        where: {
            phone,
            main_service,
            created_at: { gte: cutoff }
        },
        orderBy: { created_at: 'desc' }
    });
}

export async function create_lead(lead_in: LeadCreate): Promise<{lead: Lead, is_duplicate: boolean}> {
    const existing = await find_recent_duplicate(lead_in.phone, lead_in.main_service);
    if (existing) {
        return { lead: existing, is_duplicate: true };
    }

    let last_error: any = null;
    for (let i = 0; i < 5; i++) {
        try {
            const lead_reference = await generate_lead_reference();
            const lead = await prisma.lead.create({
                data: {
                    ...lead_in,
                    lead_reference,
                    lead_status: "New"
                }
            });
            return { lead, is_duplicate: false };
        } catch (exc: any) {
            // Prisma error P2002 is unique constraint failed
            if (exc.code === 'P2002') {
                last_error = exc;
                continue;
            }
            throw exc;
        }
    }
    throw new Error(`Could not allocate a unique lead reference: ${last_error?.message}`);
}

// --------------------------------------------------------------------------
// Read
// --------------------------------------------------------------------------
export async function get_lead(lead_id: number): Promise<Lead | null> {
    return prisma.lead.findUnique({ where: { id: lead_id } });
}

export async function get_lead_by_reference(reference: string): Promise<Lead | null> {
    return prisma.lead.findUnique({ where: { lead_reference: reference } });
}

export async function get_leads(
    skip: number = 0,
    limit: number = 100,
    status?: string,
    service?: string,
    search?: string
): Promise<{ leads: Lead[], total: number }> {
    
    const where: any = {};
    if (status) where.lead_status = status;
    if (service) where.main_service = service;
    if (search) {
        const term = `%${search.trim()}%`; // Note: Prisma has `contains` for string search, no need for %% unless raw
        where.OR = [
            { name: { contains: search.trim(), mode: 'insensitive' } },
            { phone: { contains: search.trim(), mode: 'insensitive' } },
            { email: { contains: search.trim(), mode: 'insensitive' } },
            { lead_reference: { contains: search.trim(), mode: 'insensitive' } },
            { location: { contains: search.trim(), mode: 'insensitive' } },
        ];
    }

    const [leads, total] = await Promise.all([
        prisma.lead.findMany({
            where,
            orderBy: { id: 'desc' },
            skip,
            take: limit
        }),
        prisma.lead.count({ where })
    ]);

    return { leads, total };
}

export async function count_leads(): Promise<number> {
    return prisma.lead.count();
}

export async function status_breakdown(): Promise<Record<string, number>> {
    const rows = await prisma.lead.groupBy({
        by: ['lead_status'],
        _count: { id: true }
    });
    const breakdown: Record<string, number> = {};
    for (const row of rows) {
        breakdown[row.lead_status] = row._count.id;
    }
    return breakdown;
}

// --------------------------------------------------------------------------
// Update / Delete
// --------------------------------------------------------------------------
export async function update_lead(lead_id: number, lead_in: LeadUpdate): Promise<Lead> {
    return prisma.lead.update({
        where: { id: lead_id },
        data: {
            ...lead_in,
            updated_at: new Date()
        }
    });
}

export async function delete_lead(lead_id: number): Promise<void> {
    await prisma.lead.delete({ where: { id: lead_id } });
}

// ==========================================================================
// PROPERTY VALUATIONS
// ==========================================================================
export function lead_payload_from_estimate(estimate_in: PropertyEstimateCreate): LeadCreate {
    return {
        name: estimate_in.name,
        phone: estimate_in.phone,
        email: estimate_in.email,
        main_service: "Property Valuation",
        property_type: estimate_in.valuation_property_type,
        budget: estimate_in.property_size,
        location: estimate_in.valuation_location,
        contact_method: estimate_in.contact_method,
        appointment_date: estimate_in.appointment_date,
        appointment_time: estimate_in.appointment_time,
    };
}

export function entry_note(estimate_in: PropertyEstimateCreate): string | null {
    if (!estimate_in.entry_service || estimate_in.entry_service === "Property Valuation") return null;
    return `Entered the price estimator from: ${estimate_in.entry_service}`;
}

function uploads_json(refs?: UploadRefSchema[]): string | null {
    if (!refs || refs.length === 0) return null;
    return JSON.stringify(refs.map(ref => ({
        file_id: ref.file_id,
        original_name: ref.original_name,
        media_type: ref.media_type,
        kind: ref.kind,
        size_bytes: ref.size_bytes
    })));
}

export function load_uploads(raw?: string | null): any[] {
    if (!raw) return [];
    try {
        const data = JSON.parse(raw);
        return Array.isArray(data) ? data : [];
    } catch {
        return [];
    }
}

function status_for(result: ValuationResult): string {
    const map: Record<string, string> = {
        "completed": "Completed",
        "insufficient_data": "Insufficient Data",
        "failed": "Failed"
    };
    return map[result.status] || "Pending";
}

export async function find_recent_duplicate_valuation(
    lead_id: number | null,
    estimate_in: PropertyEstimateCreate
): Promise<PropertyValuation | null> {
    if (lead_id === null) return null;
    const cutoff = new Date(Date.now() - DUPLICATE_WINDOW_MINUTES * 60000);
    return prisma.propertyValuation.findFirst({
        where: {
            lead_id,
            property_type: estimate_in.valuation_property_type,
            location: estimate_in.valuation_location,
            created_at: { gte: cutoff }
        },
        orderBy: { created_at: 'desc' }
    });
}

export async function create_valuation(
    estimate_in: PropertyEstimateCreate,
    result: ValuationResult,
    lead: Lead | null = null
): Promise<PropertyValuation> {
    const analysis = {
        status: result.status,
        provider: result.provider,
        confidence_level: result.confidence_level,
        valuation_factors: result.valuation_factors,
        missing_information: result.missing_information,
        recommendation: result.recommendation,
        message: result.message,
        disclaimer: result.disclaimer,
        detail: result.raw,
        generated_at: new Date().toISOString()
    };

    let last_error: any = null;
    for (let i = 0; i < 5; i++) {
        try {
            const valuation_reference = await generate_valuation_reference();
            return await prisma.propertyValuation.create({
                data: {
                    valuation_reference,
                    lead_id: lead ? lead.id : null,
                    property_type: estimate_in.valuation_property_type,
                    location: estimate_in.valuation_location,
                    property_size: estimate_in.property_size,
                    locality: estimate_in.locality,
                    address: estimate_in.address,
                    landmark: estimate_in.landmark,
                    pincode: estimate_in.pincode,
                    built_up_area: estimate_in.built_up_area,
                    area_unit: estimate_in.area_unit,
                    land_area: estimate_in.land_area,
                    land_area_unit: estimate_in.land_area_unit,
                    bedrooms: estimate_in.bedrooms,
                    property_age: estimate_in.property_age,
                    floor: estimate_in.floor,
                    total_floors: estimate_in.total_floors,
                    condition: estimate_in.property_condition,
                    parking: estimate_in.parking,
                    facing: estimate_in.facing,
                    road_width: estimate_in.road_width,
                    amenities: (estimate_in.amenities || []).join(", ") || null,
                    location_features: (estimate_in.location_features || []).join(", ") || null,
                    uploaded_documents: uploads_json(estimate_in.uploaded_documents),
                    uploaded_images: uploads_json(estimate_in.uploaded_images),
                    estimated_low: result.estimated_low,
                    estimated_high: result.estimated_high,
                    estimated_midpoint: result.estimated_midpoint,
                    estimated_price_per_sqft: result.price_per_sqft,
                    confidence_level: result.confidence_level,
                    ai_analysis: JSON.stringify(analysis),
                    ai_provider: result.provider,
                    valuation_status: status_for(result)
                }
            });
        } catch (exc: any) {
            if (exc.code === 'P2002') {
                last_error = exc;
                continue;
            }
            throw exc;
        }
    }
    throw new Error(`Could not allocate a unique valuation reference: ${last_error?.message}`);
}

export async function get_valuation(valuation_id: number): Promise<(PropertyValuation & { lead?: Lead | null }) | null> {
    return prisma.propertyValuation.findUnique({
        where: { id: valuation_id },
        include: { lead: true }
    });
}

export async function get_valuations(
    skip: number = 0,
    limit: number = 100,
    status?: string,
    property_type?: string,
    search?: string
): Promise<{ valuations: (PropertyValuation & { lead?: Lead | null })[], total: number }> {
    const where: any = {};
    if (status) where.valuation_status = status;
    if (property_type) where.property_type = property_type;
    if (search) {
        where.OR = [
            { valuation_reference: { contains: search.trim(), mode: 'insensitive' } },
            { location: { contains: search.trim(), mode: 'insensitive' } },
            { locality: { contains: search.trim(), mode: 'insensitive' } },
            { pincode: { contains: search.trim(), mode: 'insensitive' } },
        ];
    }

    const [valuations, total] = await Promise.all([
        prisma.propertyValuation.findMany({
            where,
            orderBy: { id: 'desc' },
            skip,
            take: limit,
            include: { lead: true }
        }),
        prisma.propertyValuation.count({ where })
    ]);

    return { valuations, total };
}

export async function count_valuations(): Promise<number> {
    return prisma.propertyValuation.count();
}

export async function set_valuation_status(valuation_id: number, status: string): Promise<PropertyValuation> {
    return prisma.propertyValuation.update({
        where: { id: valuation_id },
        data: { valuation_status: status, updated_at: new Date() }
    });
}

export async function request_professional_valuation(valuation_id: number): Promise<PropertyValuation & { lead?: Lead | null }> {
    const val = await prisma.propertyValuation.findUnique({ where: { id: valuation_id }, include: { lead: true } });
    if (!val) throw new Error("Valuation not found");

    const updateData: any = {
        valuation_status: "Professional Requested",
        updated_at: new Date()
    };
    
    let updatedLead = null;
    if (val.lead && val.lead.lead_status === "New") {
        updatedLead = await prisma.lead.update({
            where: { id: val.lead.id },
            data: { lead_status: "Follow-up", updated_at: new Date() }
        });
    }

    const updatedValuation = await prisma.propertyValuation.update({
        where: { id: valuation_id },
        data: updateData,
        include: { lead: true }
    });

    if (updatedLead) {
        updatedValuation.lead = updatedLead;
    }

    return updatedValuation;
}

export async function delete_valuation(valuation_id: number): Promise<void> {
    await prisma.propertyValuation.delete({ where: { id: valuation_id } });
}
