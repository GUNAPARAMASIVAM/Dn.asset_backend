"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.router = void 0;
const express_1 = require("express");
const multer_1 = require("multer");
const path_1 = require("path");
const fs_1 = require("fs");
const uuid_1 = require("uuid");
const zod_1 = require("zod");
const crud = require("./crud");
const schemas = require("./schemas");
const valuation_service_1 = require("./valuation_service");
exports.router = (0, express_1.Router)();
const os_1 = require("os");
// Configure uploads (use /tmp on Vercel/Serverless environments because the rest of the filesystem is read-only)
const isVercel = process.env.VERCEL || process.env.NODE_ENV === 'production';
const UPLOAD_DIR = process.env.DN_ASSET_UPLOAD_DIR || (isVercel ? path_1.default.join(os_1.default.tmpdir(), 'uploads') : path_1.default.resolve(__dirname, '../../uploads'));
try {
    if (!fs_1.default.existsSync(UPLOAD_DIR)) {
        fs_1.default.mkdirSync(UPLOAD_DIR, { recursive: true });
    }
}
catch (error) {
    console.error("Warning: Could not create upload directory. Vercel filesystem might be read-only.", error);
}
const MAX_UPLOAD_BYTES = parseInt(process.env.DN_ASSET_MAX_UPLOAD_BYTES || String(10 * 1024 * 1024), 10);
const ALLOWED_UPLOADS = {
    ".pdf": "application/pdf",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
};
const upload = (0, multer_1.default)({
    dest: UPLOAD_DIR,
    limits: { fileSize: MAX_UPLOAD_BYTES }
});
const toSnakeCase = (str) => str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
const convertKeysToSnakeCase = (obj) => {
    if (Array.isArray(obj))
        return obj.map(convertKeysToSnakeCase);
    if (obj !== null && typeof obj === 'object') {
        return Object.keys(obj).reduce((acc, key) => {
            let val = obj[key];
            if (val === "") {
                val = undefined;
            }
            else {
                val = convertKeysToSnakeCase(val);
            }
            if (val !== undefined) {
                acc[toSnakeCase(key)] = val;
            }
            return acc;
        }, {});
    }
    return obj;
};
// Middleware for validation
const validate = (schema) => (req, res, next) => {
    try {
        req.body = convertKeysToSnakeCase(req.body);
        req.body = schema.parse(req.body);
        next();
    }
    catch (err) {
        if (err instanceof zod_1.z.ZodError) {
            const issues = err.issues || [];
            const errors = issues.map(e => ({
                loc: (e.path || []).map(String),
                msg: e.message,
                type: e.code
            }));
            console.error("Zod Validation Failed:", JSON.stringify(errors, null, 2));
            return res.status(422).json({
                success: false,
                message: "Validation failed",
                detail: errors
            });
        }
        next(err);
    }
};
// --------------------------------------------------------------------------
// Health / stats
// --------------------------------------------------------------------------
exports.router.get('/health', async (req, res) => {
    try {
        await crud.prisma.$queryRaw `SELECT 1`;
        const total_leads = await crud.count_leads();
        const total_valuations = await crud.count_valuations();
        res.json({
            status: "ok",
            database: "connected",
            total_leads,
            total_valuations,
            valuation_engine: (0, valuation_service_1.provider_status)(),
            version: "2.0.0",
            timestamp: new Date().toISOString()
        });
    }
    catch (err) {
        res.json({
            status: "degraded",
            database: "unavailable",
            total_leads: 0,
            total_valuations: 0,
            valuation_engine: (0, valuation_service_1.provider_status)(),
            version: "2.0.0",
            timestamp: new Date().toISOString()
        });
    }
});
exports.router.get('/stats', async (req, res) => {
    const by_status = await crud.status_breakdown();
    const total = await crud.count_leads();
    const total_valuations = await crud.count_valuations();
    res.json({
        success: true,
        total,
        total_valuations,
        by_status,
        statuses: ["New", "Contacted", "Follow-up", "Converted", "Junk / Unqualified"],
        valuation_statuses: ["Pending", "Completed", "Insufficient Data", "Professional Requested", "Failed"]
    });
});
// --------------------------------------------------------------------------
// Leads
// --------------------------------------------------------------------------
exports.router.post('/leads', validate(schemas.LeadCreateSchema), async (req, res) => {
    try {
        const { lead, is_duplicate } = await crud.create_lead(req.body);
        res.status(201).json({
            success: true,
            lead_reference: lead.lead_reference,
            id: lead.id,
            duplicate: is_duplicate,
            message: is_duplicate ? "This requirement was already received" : "Lead created successfully"
        });
    }
    catch (err) {
        console.error("Lead creation failed:", err);
        res.status(500).json({ success: false, detail: err.message, message: err.message });
    }
});
exports.router.get('/leads', async (req, res) => {
    const skip = parseInt(req.query.skip || '0', 10);
    const limit = parseInt(req.query.limit || '100', 10);
    const lead_status = req.query.lead_status;
    const service = req.query.service;
    const search = req.query.search;
    const { leads, total } = await crud.get_leads(skip, limit, lead_status, service, search);
    res.json({
        success: true,
        count: leads.length,
        total,
        leads
    });
});
exports.router.get('/leads/reference/:reference', async (req, res) => {
    const lead = await crud.get_lead_by_reference(req.params.reference);
    if (!lead)
        return res.status(404).json({ success: false, detail: `Lead ${req.params.reference} not found` });
    res.json({ success: true, lead });
});
exports.router.get('/leads/:id', async (req, res) => {
    const lead = await crud.get_lead(parseInt(req.params.id, 10));
    if (!lead)
        return res.status(404).json({ success: false, detail: `Lead ${req.params.id} not found` });
    res.json({ success: true, lead });
});
exports.router.put('/leads/:id', validate(schemas.LeadUpdateSchema), async (req, res) => {
    const leadId = parseInt(req.params.id, 10);
    let lead = await crud.get_lead(leadId);
    if (!lead)
        return res.status(404).json({ success: false, detail: `Lead ${leadId} not found` });
    if (Object.keys(req.body).length === 0)
        return res.status(400).json({ success: false, detail: "No fields supplied to update" });
    lead = await crud.update_lead(leadId, req.body);
    res.json({ success: true, lead });
});
exports.router.delete('/leads/:id', async (req, res) => {
    const leadId = parseInt(req.params.id, 10);
    const lead = await crud.get_lead(leadId);
    if (!lead)
        return res.status(404).json({ success: false, detail: `Lead ${leadId} not found` });
    await crud.delete_lead(leadId);
    res.json({ success: true, message: `Lead ${lead.lead_reference} deleted` });
});
// --------------------------------------------------------------------------
// Property price estimator
// --------------------------------------------------------------------------
function safe_display_name(filename) {
    const raw = path_1.default.basename(filename || "upload");
    const cleaned = raw.replace(/[^a-zA-Z0-9 ._\-()]/g, '').trim() || "upload";
    return cleaned.substring(0, 120);
}
exports.router.post('/property-estimate/upload', upload.single('file'), async (req, res) => {
    const file = req.file;
    if (!file)
        return res.status(400).json({ success: false, detail: "No file provided" });
    const kind = req.body.kind || "document";
    if (kind !== "document" && kind !== "image") {
        fs_1.default.unlinkSync(file.path);
        return res.status(400).json({ success: false, detail: "kind must be 'document' or 'image'" });
    }
    const suffix = path_1.default.extname(file.originalname).toLowerCase();
    const media_type = ALLOWED_UPLOADS[suffix];
    if (!media_type) {
        fs_1.default.unlinkSync(file.path);
        return res.status(400).json({ success: false, detail: "Unsupported file type. Allowed: PDF, JPG, JPEG, PNG, WEBP." });
    }
    if (kind === "image" && media_type === "application/pdf") {
        fs_1.default.unlinkSync(file.path);
        return res.status(400).json({ success: false, detail: "Photos must be JPG, PNG or WEBP." });
    }
    const file_id = (0, uuid_1.v4)().replace(/-/g, '');
    const newPath = path_1.default.join(UPLOAD_DIR, file_id + suffix);
    fs_1.default.renameSync(file.path, newPath);
    res.status(201).json({
        success: true,
        file_id,
        original_name: safe_display_name(file.originalname),
        media_type,
        kind,
        size_bytes: file.size,
        message: "File uploaded"
    });
});
function result_to_schema(result) {
    return {
        status: result.status,
        message: result.message,
        estimated_low: result.estimated_low,
        estimated_high: result.estimated_high,
        estimated_midpoint: result.estimated_midpoint,
        price_per_sqft: result.price_per_sqft,
        confidence_level: result.confidence_level,
        valuation_factors: result.valuation_factors,
        missing_information: result.missing_information,
        recommendation: result.recommendation,
        disclaimer: result.disclaimer,
        provider: result.provider,
        estimated_low_display: (0, valuation_service_1.format_inr)(result.estimated_low),
        estimated_high_display: (0, valuation_service_1.format_inr)(result.estimated_high),
        estimated_midpoint_display: (0, valuation_service_1.format_inr)(result.estimated_midpoint),
        price_per_sqft_display: result.price_per_sqft ? `₹${result.price_per_sqft.toLocaleString('en-IN')} / Sq.ft` : null
    };
}
function stored_result(valuation) {
    if (!valuation || !valuation.ai_analysis)
        return null;
    let analysis;
    try {
        analysis = JSON.parse(valuation.ai_analysis);
    }
    catch {
        return null;
    }
    const per_sqft = valuation.estimated_price_per_sqft ? parseFloat(valuation.estimated_price_per_sqft) : null;
    return {
        status: analysis?.status || "completed",
        message: analysis?.message,
        estimated_low: valuation.estimated_low,
        estimated_high: valuation.estimated_high,
        estimated_midpoint: valuation.estimated_midpoint,
        price_per_sqft: per_sqft,
        confidence_level: valuation.confidence_level,
        valuation_factors: analysis?.valuation_factors || [],
        missing_information: analysis?.missing_information || [],
        recommendation: analysis?.recommendation || "",
        disclaimer: analysis?.disclaimer || "",
        provider: analysis?.provider || valuation.ai_provider || "unknown",
        estimated_low_display: (0, valuation_service_1.format_inr)(valuation.estimated_low),
        estimated_high_display: (0, valuation_service_1.format_inr)(valuation.estimated_high),
        estimated_midpoint_display: (0, valuation_service_1.format_inr)(valuation.estimated_midpoint),
        price_per_sqft_display: per_sqft ? `₹${per_sqft.toLocaleString('en-IN')} / Sq.ft` : null
    };
}
function valuation_out(valuation) {
    const out = { ...valuation };
    out.document_count = (0, valuation_service_1.load_uploads)(valuation.uploaded_documents).length;
    out.image_count = (0, valuation_service_1.load_uploads)(valuation.uploaded_images).length;
    if (valuation.estimated_low && valuation.estimated_high) {
        out.estimated_range_display = `${(0, valuation_service_1.format_inr)(valuation.estimated_low)} – ${(0, valuation_service_1.format_inr)(valuation.estimated_high)}`;
    }
    out.estimated_midpoint_display = (0, valuation_service_1.format_inr)(valuation.estimated_midpoint);
    if (valuation.lead) {
        out.lead_reference = valuation.lead.lead_reference;
        out.customer_name = valuation.lead.name;
    }
    return out;
}
function resolve_upload(file_id) {
    if (!/^[a-zA-Z0-9_-]+$/.test(file_id))
        return undefined;
    const files = fs_1.default.readdirSync(UPLOAD_DIR);
    for (const file of files) {
        if (file.startsWith(file_id + '.')) {
            const ext = path_1.default.extname(file).toLowerCase();
            if (ALLOWED_UPLOADS[ext]) {
                return path_1.default.join(UPLOAD_DIR, file);
            }
        }
    }
    return undefined;
}
function to_valuation_input(estimate_in) {
    const to_upload_refs = (refs) => (refs || []).map(ref => ({
        ...ref,
        path: resolve_upload(ref.file_id)
    }));
    return {
        property_type: estimate_in.valuation_property_type,
        location: estimate_in.valuation_location,
        property_size: estimate_in.property_size,
        locality: estimate_in.locality,
        pincode: estimate_in.pincode,
        address: estimate_in.address,
        landmark: estimate_in.landmark,
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
        amenities: estimate_in.amenities || [],
        location_features: estimate_in.location_features || [],
        images: to_upload_refs(estimate_in.uploaded_images),
        documents: to_upload_refs(estimate_in.uploaded_documents)
    };
}
exports.router.post('/property-estimate', validate(schemas.PropertyEstimateCreateSchema), async (req, res) => {
    try {
        const estimate_in = req.body;
        const leadPayload = crud.lead_payload_from_estimate(estimate_in);
        const { lead, is_duplicate: lead_duplicate } = await crud.create_lead(leadPayload);
        const note = crud.entry_note(estimate_in);
        if (note && lead.notes !== note) {
            await crud.update_lead(lead.id, { notes: note });
        }
        const existing = await crud.find_recent_duplicate_valuation(lead.id, estimate_in);
        if (existing) {
            const stored = stored_result(existing) || {
                status: "insufficient_data",
                message: "Insufficient market data for a reliable estimate.",
                recommendation: "Request a professional valuation from a DN Asset expert.",
                disclaimer: "",
                provider: existing.ai_provider || "unknown"
            };
            return res.status(201).json({
                success: true,
                status: stored.status,
                estimated_low: stored.estimated_low,
                estimated_high: stored.estimated_high,
                estimated_midpoint: stored.estimated_midpoint,
                price_per_sqft: stored.price_per_sqft,
                confidence: stored.confidence_level,
                factors: stored.valuation_factors,
                missing_information: stored.missing_information,
                recommendation: stored.recommendation,
                disclaimer: stored.disclaimer,
                valuation_reference: existing.valuation_reference,
                lead_reference: lead.lead_reference,
                id: existing.id,
                lead_id: lead.id,
                duplicate: true,
                message: "This property was already valued",
                result: stored
            });
        }
        const service = (0, valuation_service_1.get_valuation_service)();
        let result;
        try {
            result = await service.estimate(to_valuation_input(estimate_in));
        }
        catch (exc) {
            console.error("Valuation engine raised", exc);
            return res.status(502).json({
                success: false,
                detail: "The valuation service is temporarily unavailable. Please request a professional valuation."
            });
        }
        const valuation = await crud.create_valuation(estimate_in, result, lead);
        const schemaResult = result_to_schema(result);
        res.status(201).json({
            success: true,
            status: schemaResult.status,
            estimated_low: schemaResult.estimated_low,
            estimated_high: schemaResult.estimated_high,
            estimated_midpoint: schemaResult.estimated_midpoint,
            price_per_sqft: schemaResult.price_per_sqft,
            confidence: schemaResult.confidence_level,
            factors: schemaResult.valuation_factors,
            missing_information: schemaResult.missing_information,
            recommendation: schemaResult.recommendation,
            disclaimer: schemaResult.disclaimer,
            valuation_reference: valuation.valuation_reference,
            lead_reference: lead.lead_reference,
            id: valuation.id,
            lead_id: lead.id,
            duplicate: lead_duplicate,
            message: "Valuation created successfully",
            result: schemaResult
        });
    }
    catch (err) {
        res.status(500).json({ success: false, detail: err.message, message: err.message });
    }
});
exports.router.get('/property-estimates', async (req, res) => {
    const skip = parseInt(req.query.skip || '0', 10);
    const limit = parseInt(req.query.limit || '100', 10);
    const valuation_status = req.query.valuation_status;
    const property_type = req.query.property_type;
    const search = req.query.search;
    const { valuations, total } = await crud.get_valuations(skip, limit, valuation_status, property_type, search);
    res.json({
        success: true,
        count: valuations.length,
        total,
        valuations: valuations.map(valuation_out)
    });
});
exports.router.get('/property-estimates/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const valuation = await crud.get_valuation(id);
    if (!valuation)
        return res.status(404).json({ success: false, detail: `Valuation ${id} not found` });
    let analysis = null;
    if (valuation.ai_analysis) {
        try {
            analysis = JSON.parse(valuation.ai_analysis);
        }
        catch { }
    }
    res.json({
        success: true,
        valuation: valuation_out(valuation),
        result: stored_result(valuation),
        ai_analysis: analysis
    });
});
exports.router.get('/property-estimates/:id/result', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const valuation = await crud.get_valuation(id);
    if (!valuation)
        return res.status(404).json({ success: false, detail: `Valuation ${id} not found` });
    res.json({
        success: true,
        valuation: valuation_out(valuation),
        result: stored_result(valuation),
        ai_analysis: null
    });
});
exports.router.post('/property-estimates/:id/professional-valuation', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    let valuation = await crud.get_valuation(id);
    if (!valuation)
        return res.status(404).json({ success: false, detail: `Valuation ${id} not found` });
    valuation = await crud.request_professional_valuation(id);
    res.json({
        success: true,
        valuation_reference: valuation.valuation_reference,
        lead_reference: valuation.lead?.lead_reference,
        valuation_status: valuation.valuation_status,
        message: "A DN Asset valuer will contact you to arrange a professional valuation."
    });
});
exports.router.put('/property-estimates/:id', validate(schemas.ValuationUpdateSchema), async (req, res) => {
    const id = parseInt(req.params.id, 10);
    let valuation = await crud.get_valuation(id);
    if (!valuation)
        return res.status(404).json({ success: false, detail: `Valuation ${id} not found` });
    if (!req.body.valuation_status)
        return res.status(400).json({ success: false, detail: "No fields supplied to update" });
    valuation = await crud.set_valuation_status(id, req.body.valuation_status);
    res.json({
        success: true,
        valuation: valuation_out(valuation),
        result: stored_result(valuation)
    });
});
