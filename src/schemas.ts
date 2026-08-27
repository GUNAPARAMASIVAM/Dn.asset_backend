import { z } from 'zod';

// Utility for formatting names and fields
export const NAME_REGEX = /^[A-Za-zÀ-ɏ][A-Za-zÀ-ɏ .'\-]{1,119}$/;
export const EMAIL_REGEX = /^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/;
export const INDIAN_MOBILE_REGEX = /^[6-9]\d{9}$/;
export const PINCODE_REGEX = /^[1-9]\d{5}$/;
export const FILE_ID_REGEX = /^[0-9a-f]{32}$/;

const MAIN_SERVICES = [
  "Buy Property",
  "Sell Property",
  "Lease / Rent Property",
  "Property Management",
  "Property Documents",
  "NRI Property Services",
  "Property Valuation",
  "Talk to an Expert"
] as const;

const CONTACT_METHODS = [
  "WhatsApp",
  "Phone Call",
  "Email",
  "Schedule Appointment"
] as const;

export const LeadCreateSchema = z.object({
  name: z.string().min(2).max(120).regex(NAME_REGEX, "Invalid name format"),
  phone: z.string().min(6).max(20),
  email: z.string().max(160).regex(EMAIL_REGEX, "Invalid email address"),
  main_service: z.enum(MAIN_SERVICES),
  
  property_type: z.string().max(60).optional(),
  budget: z.string().max(60).optional(),
  location: z.string().max(80).optional(),
  purpose: z.string().max(60).optional(),
  
  sell_property_type: z.string().max(60).optional(),
  expected_price: z.string().max(60).optional(),
  sell_service: z.string().max(80).optional(),
  
  lease_type: z.string().max(80).optional(),
  lease_duration: z.string().max(40).optional(),
  
  management_service: z.string().max(80).optional(),
  nri_service: z.string().max(80).optional(),
  document_service: z.string().max(255).optional(),
  
  contact_method: z.enum(CONTACT_METHODS).optional(),
  appointment_date: z.string().optional(),
  appointment_time: z.string().optional()
}).superRefine((data, ctx) => {
  if (data.contact_method === "Schedule Appointment" && (!data.appointment_date || !data.appointment_time)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "An appointment date and time slot are required when scheduling an appointment.",
    });
  }
});

export const LeadUpdateSchema = z.object({
  lead_status: z.string().optional(),
  notes: z.string().optional()
});

export const UploadRefSchema = z.object({
  file_id: z.string().regex(FILE_ID_REGEX),
  original_name: z.string(),
  media_type: z.string(),
  kind: z.string(),
  size_bytes: z.number().int().nonnegative()
});

export const PropertyEstimateCreateSchema = z.object({
  name: z.string().regex(NAME_REGEX).max(120),
  phone: z.string().min(6).max(20),
  email: z.string().regex(EMAIL_REGEX).max(160),
  contact_method: z.enum(CONTACT_METHODS).optional(),
  appointment_date: z.string().optional(),
  appointment_time: z.string().optional(),

  valuation_property_type: z.string(),
  valuation_location: z.string(),
  property_size: z.string().optional(),
  
  locality: z.string().optional(),
  pincode: z.string().optional(),
  address: z.string().optional(),
  landmark: z.string().optional(),

  built_up_area: z.number().optional(),
  area_unit: z.string().optional(),
  land_area: z.number().optional(),
  land_area_unit: z.string().optional(),

  bedrooms: z.string().optional(),
  property_age: z.string().optional(),
  floor: z.string().optional(),
  total_floors: z.string().optional(),
  property_condition: z.string().optional(),

  parking: z.string().optional(),
  facing: z.string().optional(),
  road_width: z.string().optional(),

  amenities: z.array(z.string()).optional(),
  location_features: z.array(z.string()).optional(),

  uploaded_images: z.array(UploadRefSchema).optional(),
  uploaded_documents: z.array(UploadRefSchema).optional(),

  entry_service: z.string().optional()
}).superRefine((data, ctx) => {
  if (data.contact_method === "Schedule Appointment" && (!data.appointment_date || !data.appointment_time)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "An appointment date and time slot are required when scheduling an appointment.",
    });
  }
});

export const ValuationUpdateSchema = z.object({
  valuation_status: z.string()
});

export type LeadCreate = z.infer<typeof LeadCreateSchema>;
export type LeadUpdate = z.infer<typeof LeadUpdateSchema>;
export type PropertyEstimateCreate = z.infer<typeof PropertyEstimateCreateSchema>;
export type UploadRefSchema = z.infer<typeof UploadRefSchema>;
