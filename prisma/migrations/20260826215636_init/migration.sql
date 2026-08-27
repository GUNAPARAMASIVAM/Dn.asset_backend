-- CreateTable
CREATE TABLE "leads" (
    "id" SERIAL NOT NULL,
    "lead_reference" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "main_service" TEXT NOT NULL,
    "property_type" TEXT,
    "budget" TEXT,
    "location" TEXT,
    "purpose" TEXT,
    "sell_property_type" TEXT,
    "expected_price" TEXT,
    "sell_service" TEXT,
    "lease_type" TEXT,
    "lease_duration" TEXT,
    "management_service" TEXT,
    "nri_service" TEXT,
    "document_service" TEXT,
    "contact_method" TEXT,
    "appointment_date" TIMESTAMP(3),
    "appointment_time" TEXT,
    "lead_status" TEXT NOT NULL DEFAULT 'New',
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "property_valuations" (
    "id" SERIAL NOT NULL,
    "valuation_reference" TEXT NOT NULL,
    "lead_id" INTEGER,
    "property_type" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "locality" TEXT,
    "address" TEXT,
    "landmark" TEXT,
    "pincode" TEXT,
    "property_size" TEXT,
    "built_up_area" DOUBLE PRECISION,
    "area_unit" TEXT,
    "land_area" DOUBLE PRECISION,
    "land_area_unit" TEXT,
    "bedrooms" TEXT,
    "property_age" TEXT,
    "floor" TEXT,
    "total_floors" TEXT,
    "condition" TEXT,
    "parking" TEXT,
    "facing" TEXT,
    "road_width" TEXT,
    "amenities" TEXT,
    "location_features" TEXT,
    "uploaded_documents" TEXT,
    "uploaded_images" TEXT,
    "estimated_low" BIGINT,
    "estimated_high" BIGINT,
    "estimated_midpoint" BIGINT,
    "estimated_price_per_sqft" DOUBLE PRECISION,
    "confidence_level" TEXT,
    "ai_analysis" TEXT,
    "ai_provider" TEXT,
    "valuation_status" TEXT NOT NULL DEFAULT 'Pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "property_valuations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "leads_lead_reference_key" ON "leads"("lead_reference");

-- CreateIndex
CREATE UNIQUE INDEX "property_valuations_valuation_reference_key" ON "property_valuations"("valuation_reference");

-- AddForeignKey
ALTER TABLE "property_valuations" ADD CONSTRAINT "property_valuations_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
