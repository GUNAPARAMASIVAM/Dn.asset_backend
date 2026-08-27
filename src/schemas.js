"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ValuationUpdateSchema = exports.PropertyEstimateCreateSchema = exports.UploadRefSchema = exports.LeadUpdateSchema = exports.LeadCreateSchema = exports.FILE_ID_REGEX = exports.PINCODE_REGEX = exports.INDIAN_MOBILE_REGEX = exports.EMAIL_REGEX = exports.NAME_REGEX = void 0;
const zod_1 = require("zod");
// Utility for formatting names and fields
exports.NAME_REGEX = /^[A-Za-zÀ-ɏ][A-Za-zÀ-ɏ .'\-]{1,119}$/;
exports.EMAIL_REGEX = /^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/;
exports.INDIAN_MOBILE_REGEX = /^[6-9]\d{9}$/;
exports.PINCODE_REGEX = /^[1-9]\d{5}$/;
exports.FILE_ID_REGEX = /^[0-9a-f]{32}$/;
const MAIN_SERVICES = [
    "Buy Property",
    "Sell Property",
    "Lease / Rent Property",
    "Property Management",
    "Property Documents",
    "NRI Property Services",
    "Property Valuation",
    "Talk to an Expert"
];
const CONTACT_METHODS = [
    "WhatsApp",
    "Phone Call",
    "Email",
    "Schedule Appointment"
];
exports.LeadCreateSchema = zod_1.z.object({
    name: zod_1.z.string().min(2).max(120).regex(exports.NAME_REGEX, "Invalid name format"),
    phone: zod_1.z.string().min(6).max(20),
    email: zod_1.z.string().max(160).regex(exports.EMAIL_REGEX, "Invalid email address"),
    main_service: zod_1.z.enum(MAIN_SERVICES),
    property_type: zod_1.z.string().max(60).optional(),
    budget: zod_1.z.string().max(60).optional(),
    location: zod_1.z.string().max(80).optional(),
    purpose: zod_1.z.string().max(60).optional(),
    sell_property_type: zod_1.z.string().max(60).optional(),
    expected_price: zod_1.z.string().max(60).optional(),
    sell_service: zod_1.z.string().max(80).optional(),
    lease_type: zod_1.z.string().max(80).optional(),
    lease_duration: zod_1.z.string().max(40).optional(),
    management_service: zod_1.z.string().max(80).optional(),
    nri_service: zod_1.z.string().max(80).optional(),
    document_service: zod_1.z.string().max(255).optional(),
    contact_method: zod_1.z.enum(CONTACT_METHODS).optional(),
    appointment_date: zod_1.z.string().optional(),
    appointment_time: zod_1.z.string().optional()
}).superRefine((data, ctx) => {
    if (data.contact_method === "Schedule Appointment" && (!data.appointment_date || !data.appointment_time)) {
        ctx.addIssue({
            code: zod_1.z.ZodIssueCode.custom,
            message: "An appointment date and time slot are required when scheduling an appointment.",
        });
    }
});
exports.LeadUpdateSchema = zod_1.z.object({
    lead_status: zod_1.z.string().optional(),
    notes: zod_1.z.string().optional()
});
exports.UploadRefSchema = zod_1.z.object({
    file_id: zod_1.z.string().regex(exports.FILE_ID_REGEX),
    original_name: zod_1.z.string(),
    media_type: zod_1.z.string(),
    kind: zod_1.z.string(),
    size_bytes: zod_1.z.number().int().nonnegative()
});
exports.PropertyEstimateCreateSchema = zod_1.z.object({
    name: zod_1.z.string().regex(exports.NAME_REGEX).max(120),
    phone: zod_1.z.string().min(6).max(20),
    email: zod_1.z.string().regex(exports.EMAIL_REGEX).max(160),
    contact_method: zod_1.z.enum(CONTACT_METHODS).optional(),
    appointment_date: zod_1.z.string().optional(),
    appointment_time: zod_1.z.string().optional(),
    valuation_property_type: zod_1.z.string(),
    valuation_location: zod_1.z.string(),
    property_size: zod_1.z.string().optional(),
    locality: zod_1.z.string().optional(),
    pincode: zod_1.z.string().optional(),
    address: zod_1.z.string().optional(),
    landmark: zod_1.z.string().optional(),
    built_up_area: zod_1.z.number().optional(),
    area_unit: zod_1.z.string().optional(),
    land_area: zod_1.z.number().optional(),
    land_area_unit: zod_1.z.string().optional(),
    bedrooms: zod_1.z.string().optional(),
    property_age: zod_1.z.string().optional(),
    floor: zod_1.z.string().optional(),
    total_floors: zod_1.z.string().optional(),
    property_condition: zod_1.z.string().optional(),
    parking: zod_1.z.string().optional(),
    facing: zod_1.z.string().optional(),
    road_width: zod_1.z.string().optional(),
    amenities: zod_1.z.array(zod_1.z.string()).optional(),
    location_features: zod_1.z.array(zod_1.z.string()).optional(),
    uploaded_images: zod_1.z.array(exports.UploadRefSchema).optional(),
    uploaded_documents: zod_1.z.array(exports.UploadRefSchema).optional(),
    entry_service: zod_1.z.string().optional()
}).superRefine((data, ctx) => {
    if (data.contact_method === "Schedule Appointment" && (!data.appointment_date || !data.appointment_time)) {
        ctx.addIssue({
            code: zod_1.z.ZodIssueCode.custom,
            message: "An appointment date and time slot are required when scheduling an appointment.",
        });
    }
});
exports.ValuationUpdateSchema = zod_1.z.object({
    valuation_status: zod_1.z.string()
});
