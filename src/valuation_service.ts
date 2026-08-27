import fs from 'fs';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';

dotenv.config();

const logger = console; // Basic logger replacement

const BASE_DIR = __dirname;
const RATES_PATH = process.env.DN_ASSET_MARKET_RATES || path.resolve(BASE_DIR, '../../backend/market_rates.json');

const CLAUDE_MODEL = process.env.DN_ASSET_AI_MODEL || "claude-3-5-sonnet-20240620"; 
// Note: using latest sonnet since opus-5 doesn't exist (it was a placeholder in python)
const CLAUDE_EFFORT = process.env.DN_ASSET_AI_EFFORT || undefined; // "medium" in python, not needed unless specified for newer models
const CLAUDE_MAX_TOKENS = parseInt(process.env.DN_ASSET_AI_MAX_TOKENS || "8000", 10);
const CLAUDE_TIMEOUT = parseFloat(process.env.DN_ASSET_AI_TIMEOUT || "120") * 1000; // ms

const MAX_IMAGES_TO_AI = parseInt(process.env.DN_ASSET_AI_MAX_IMAGES || "4", 10);
const MAX_BYTES_TO_AI = parseInt(process.env.DN_ASSET_AI_MAX_FILE_BYTES || String(4 * 1024 * 1024), 10);
const SEND_DOCUMENTS_TO_AI = process.env.DN_ASSET_AI_SEND_DOCUMENTS === "1";

const DISCLAIMER = "AI-generated indicative estimate. Actual market value may vary based on current market conditions, exact location, property condition, legal status, demand, and comparable transactions. This is not a certified valuation.";
const INSUFFICIENT_MESSAGE = "Insufficient market data for a reliable estimate.";

const LAND_TYPES = new Set(["Land / Plot"]);

const PROPERTY_TYPE_ALIASES: Record<string, string> = {
    "Commercial": "Commercial Property",
    "Commercial Property": "Commercial",
    "New Project": "Apartment",
};

export interface UploadRef {
    file_id: string;
    original_name: string;
    media_type: string;
    kind: "document" | "image";
    size_bytes?: number;
    path?: string;
}

export interface ValuationInput {
    property_type: string;
    location: string;
    property_size?: string;
    locality?: string;
    pincode?: string;
    address?: string;
    landmark?: string;

    built_up_area?: number;
    area_unit?: string;
    land_area?: number;
    land_area_unit?: string;

    bedrooms?: string;
    property_age?: string;
    floor?: string;
    total_floors?: string;
    condition?: string;
    parking?: string;
    facing?: string;
    road_width?: string;

    amenities: string[];
    location_features: string[];

    images: UploadRef[];
    documents: UploadRef[];
}

export interface ValuationResult {
    status: "completed" | "insufficient_data" | "failed";
    provider: string;
    estimated_low?: number;
    estimated_high?: number;
    estimated_midpoint?: number;
    price_per_sqft?: number;
    confidence_level?: string;
    valuation_factors: string[];
    missing_information: string[];
    recommendation: string;
    message: string;
    disclaimer: string;
    raw: Record<string, any>;
}

function format_inr(amount?: number): string {
    if (amount === undefined || amount === null) return "-";
    if (amount >= 1_00_00_000) {
        let val = (amount / 1_00_00_000).toFixed(2);
        return `₹${val.replace(/\.?0+$/, '')} Cr`;
    }
    if (amount >= 1_00_000) {
        let val = (amount / 1_00_000).toFixed(2);
        return `₹${val.replace(/\.?0+$/, '')} Lakhs`;
    }
    return `₹${amount.toLocaleString('en-IN')}`;
}

function round_to(value: number, nearest: number): number {
    return Math.round(value / nearest) * nearest;
}

function load_rates(): Record<string, any> {
    try {
        const data = fs.readFileSync(RATES_PATH, 'utf-8');
        return JSON.parse(data);
    } catch (err: any) {
        logger.warn(`Market rate file not found or invalid at ${RATES_PATH}: ${err.message}`);
        return {};
    }
}

class RateBook {
    data: Record<string, any>;

    constructor(data?: Record<string, any>) {
        this.data = data || load_rates();
    }

    get source(): string { return this.data.source || "unspecified"; }
    get last_reviewed(): string { return this.data.last_reviewed || "unknown"; }
    get adjustments(): Record<string, any> { return this.data.adjustments || {}; }

    unit_to_sqft(unit?: string): number | null {
        if (!unit) return null;
        return this.data.unit_to_sqft?.[unit] || null;
    }

    base_range(city: string, property_type: string): {low: number, high: number} | null {
        const city_rates = this.data.cities?.[city];
        if (!city_rates) return null;
        const entry = city_rates[property_type] || city_rates[PROPERTY_TYPE_ALIASES[property_type] || ""];
        if (!entry) return null;
        return { low: parseFloat(entry.low), high: parseFloat(entry.high) };
    }

    size_bucket(label?: string): {representative_sqft: number, spread_bonus: number} | null {
        if (!label) return null;
        const entry = this.data.size_buckets?.[label];
        if (!entry) return null;
        return {
            representative_sqft: parseFloat(entry.representative_sqft),
            spread_bonus: parseFloat(entry.spread_bonus || "0.10"),
        };
    }

    known_cities(): string[] {
        return Object.keys(this.data.cities || {}).sort();
    }
}

function area_in_sqft(payload: ValuationInput, book: RateBook): number | null {
    let value: number | undefined;
    let unit: string | undefined;

    if (LAND_TYPES.has(payload.property_type)) {
        value = payload.land_area;
        unit = payload.land_area_unit;
    } else {
        value = payload.built_up_area;
        unit = payload.area_unit;
        if (!value) {
            value = payload.land_area;
            unit = payload.land_area_unit;
        }
    }

    if (value) {
        const factor = book.unit_to_sqft(unit) || 1.0;
        return value * factor;
    }

    const bucket = book.size_bucket(payload.property_size);
    return bucket ? bucket.representative_sqft : null;
}

function missing_fields(payload: ValuationInput, book: RateBook): string[] {
    const missing: string[] = [];
    const area = area_in_sqft(payload, book);
    if (area === null) {
        missing.push("Property size");
    } else if (!(payload.built_up_area || payload.land_area)) {
        missing.push(`Exact built-up area (this estimate assumes ~${area.toLocaleString('en-IN')} sq.ft)`);
    }

    if (!payload.locality && (payload.location === "Other Tamil Nadu" || payload.location === "Other India")) {
        missing.push("Exact locality / city");
    } else if (!payload.locality) {
        missing.push(`Street-level locality within ${payload.location}`);
    }

    if (!payload.property_age) missing.push("Property age");
    if (!payload.condition) missing.push("Current property condition");
    missing.push("Recent comparable transactions in the same street or building");
    missing.push("Legal and document status (title, encumbrance, approvals)");
    return missing;
}

function confidence(payload: ValuationInput, book: RateBook): string {
    let score = 0;
    if (payload.built_up_area || payload.land_area) score += 2;
    else if (payload.property_size) score += 1;
    if (payload.property_age) score += 1;
    if (payload.condition) score += 1;
    if (payload.locality || payload.pincode) score += 1;
    if (payload.location_features && payload.location_features.length > 0) score += 1;
    return score >= 2 ? "Medium" : "Low";
}

function describe_factors(payload: ValuationInput): string[] {
    const factors = [
        "Property type considered",
        "Location considered",
        "Property size considered",
    ];
    if (payload.property_age) factors.push("Property age considered");
    if (payload.condition) factors.push("Property condition considered");
    if (payload.amenities?.length || payload.location_features?.length) factors.push("Amenities and location features considered");
    if (payload.images?.length || payload.documents?.length) factors.push("Uploaded details considered");
    return factors;
}

export interface AIValuationService {
    name: string;
    estimate(payload: ValuationInput): Promise<ValuationResult>;
    describe(): Record<string, any>;
}

export class NullValuationService implements AIValuationService {
    name = "none";
    async estimate(payload: ValuationInput): Promise<ValuationResult> {
        return {
            status: "insufficient_data",
            provider: this.name,
            message: INSUFFICIENT_MESSAGE,
            missing_information: ["Market rate reference data is not configured"],
            recommendation: "Request a professional valuation from a DN Asset expert - no automated estimate is available for this property.",
            valuation_factors: [],
            disclaimer: DISCLAIMER,
            raw: {}
        };
    }
    describe() { return { provider: this.name }; }
}

export class ReferenceRateValuationService implements AIValuationService {
    name = "reference";
    book: RateBook;

    constructor(book?: RateBook) {
        this.book = book || new RateBook();
    }

    _multiplier(payload: ValuationInput): { multiplier: number, applied: string[] } {
        const adj = this.book.adjustments;
        const applied: string[] = [];
        let multiplier = 1.0;

        const table_mappings = [
            { key: payload.property_age, table_name: "property_age", label: "Property age" },
            { key: payload.condition, table_name: "condition", label: "Condition" },
            { key: payload.floor, table_name: "floor", label: "Floor level" },
            { key: payload.road_width, table_name: "road_width", label: "Road width" },
        ];

        for (const mapping of table_mappings) {
            const table = adj[mapping.table_name] || {};
            if (mapping.key && table[mapping.key]) {
                multiplier *= parseFloat(table[mapping.key]);
                applied.push(`${mapping.label}: ${mapping.key}`);
            }
        }

        const feature_table = adj.location_features || {};
        let feature_multiplier = 1.0;
        for (const feature of (payload.location_features || [])) {
            if (feature_table[feature]) {
                feature_multiplier *= parseFloat(feature_table[feature]);
            }
        }
        const cap = parseFloat(adj.location_features_cap || "1.12");
        feature_multiplier = Math.min(feature_multiplier, cap);
        if (payload.location_features && payload.location_features.length > 0) {
            multiplier *= feature_multiplier;
            applied.push("Location: " + payload.location_features.slice(0, 3).join(", "));
        }

        const per_item = parseFloat(adj.amenities_bonus_per_item || "0.0");
        const bonus_cap = parseFloat(adj.amenities_bonus_cap || "0.0");
        const bonus = Math.min((payload.amenities || []).length * per_item, bonus_cap);
        if (bonus) {
            multiplier *= (1 + bonus);
            applied.push(`${payload.amenities.length} amenities recorded`);
        }

        return { multiplier, applied };
    }

    async estimate(payload: ValuationInput): Promise<ValuationResult> {
        const base = this.book.base_range(payload.location, payload.property_type);
        const area = area_in_sqft(payload, this.book);
        const missing = missing_fields(payload, this.book);

        if (!base) {
            return {
                status: "insufficient_data",
                provider: this.name,
                message: INSUFFICIENT_MESSAGE,
                missing_information: [
                    `DN Asset reference rates for ${payload.property_type} in ${payload.location}`,
                    ...missing
                ],
                recommendation: "We do not hold verified rate data for this location and property type. Request a professional valuation for an accurate figure.",
                valuation_factors: [],
                disclaimer: DISCLAIMER,
                raw: { rate_source: this.book.source, known_cities: this.book.known_cities() }
            };
        }

        if (!area) {
            return {
                status: "insufficient_data",
                provider: this.name,
                message: INSUFFICIENT_MESSAGE,
                missing_information: missing,
                recommendation: "Property size is required for an indicative estimate. Share the built-up or land area, or request a professional valuation.",
                valuation_factors: [],
                disclaimer: DISCLAIMER,
                raw: { rate_source: this.book.source }
            };
        }

        const adj = this.book.adjustments;
        const factor = this._multiplier(payload);
        const bucket = this.book.size_bucket(payload.property_size);
        const exact_area = Boolean(payload.built_up_area || payload.land_area);

        let spread = parseFloat(adj.range_spread || "0.12");
        if (!payload.locality && !payload.pincode) spread += parseFloat(adj.spread_no_locality || "0.06");
        if (!payload.property_age) spread += parseFloat(adj.spread_missing_details || "0.04");
        if (bucket && !exact_area) spread += bucket.spread_bonus;
        spread = Math.min(spread, parseFloat(adj.spread_max || "0.28"));

        const centre_rate = (base.low + base.high) / 2.0;
        const mid = centre_rate * factor.multiplier * area;
        const low = mid * (1 - spread);
        const high = mid * (1 + spread);

        return {
            status: "completed",
            provider: this.name,
            estimated_low: round_to(low, 10_000),
            estimated_high: round_to(high, 10_000),
            estimated_midpoint: round_to(mid, 10_000),
            price_per_sqft: Math.round((mid / area) * 100) / 100,
            confidence_level: confidence(payload, this.book),
            valuation_factors: describe_factors(payload),
            missing_information: missing,
            recommendation: "Book a professional valuation before listing, negotiating, or using this figure for a loan or legal purpose.",
            message: "",
            disclaimer: DISCLAIMER,
            raw: {
                engine: "reference-rates",
                base_rate_per_sqft: base,
                centre_rate_per_sqft: Math.round(centre_rate * 100) / 100,
                adjustment_multiplier: Math.round(factor.multiplier * 10000) / 10000,
                adjustments_applied: factor.applied,
                range_spread_applied: Math.round(spread * 1000) / 1000,
                area_sqft: Math.round(area * 100) / 100,
                area_source: (bucket && !exact_area) ? "size band" : "measured",
                property_size_band: payload.property_size,
                rate_source: this.book.source,
                rates_last_reviewed: this.book.last_reviewed,
            }
        };
    }
    describe() { return { provider: this.name }; }
}

const VALUATION_SCHEMA = {
    type: "object",
    properties: {
        insufficient_data: {
            type: "boolean",
            description: "True when no reliable market basis exists. Set all numbers to 0.",
        },
        estimated_low: { type: "number", description: "Low end of the range in INR" },
        estimated_high: { type: "number", description: "High end of the range in INR" },
        estimated_midpoint: { type: "number", description: "Midpoint in INR" },
        price_per_sqft: { type: "number", description: "Approximate INR per sq.ft" },
        confidence_level: { type: "string", enum: ["Low", "Medium", "High"] },
        valuation_factors: {
            type: "array",
            items: { type: "string" },
            description: "Short bullet points explaining what drove the estimate",
        },
        missing_information: {
            type: "array",
            items: { type: "string" },
            description: "What would materially change the figure if known",
        },
        recommendation: { type: "string" },
        reasoning_summary: { type: "string" },
    },
    required: [
        "insufficient_data",
        "estimated_low",
        "estimated_high",
        "estimated_midpoint",
        "price_per_sqft",
        "confidence_level",
        "valuation_factors",
        "missing_information",
        "recommendation",
        "reasoning_summary",
    ],
    additionalProperties: false,
};

const SYSTEM_PROMPT = `You are an AI-assisted real-estate valuation analyst for DN Asset, an Indian property firm.

Estimate an indicative market-value range for the property described by the user.
Do not claim certainty.

Consider: property type, location, locality, built-up area, land area, bedrooms,
property age, floor, total floors, condition, parking, amenities, road width,
nearby infrastructure, the available property documents, and property images
where appropriate.

Rules you must follow:
1. DN Asset reference rates are supplied to you as the factual basis for pricing.
   Anchor every figure to them. Do NOT invent market rates from memory and do not
   substitute your own recollection of Indian property prices.
2. If no reference rate is supplied for this location and property type, or the
   property size is unknown, set "insufficient_data" to true, set every number to
   0, and explain what is missing. Never guess a number to fill the gap.
3. Images may inform condition, finish quality, and visible characteristics only.
   An image alone can never determine property value - never treat it as pricing
   evidence.
4. Keep the range realistic: a spread narrower than 8% overstates precision, and a
   spread wider than 40% is not useful to the customer.
5. "confidence_level" reflects how much verified information you had. Without
   recent comparable transactions for the same street or building, the maximum is
   "Medium".
6. Return only the structured fields requested. This is an indicative AI estimate,
   not a certified valuation.`;

export class ClaudeValuationService implements AIValuationService {
    name = "claude";
    book: RateBook;
    fallback: ReferenceRateValuationService;
    _client: Anthropic | null = null;

    constructor(book?: RateBook) {
        this.book = book || new RateBook();
        this.fallback = new ReferenceRateValuationService(this.book);
    }

    _get_client(): Anthropic {
        if (this._client) return this._client;
        if (!process.env.ANTHROPIC_API_KEY) {
            throw new Error("ANTHROPIC_API_KEY is not set.");
        }
        this._client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        return this._client;
    }

    _property_brief(payload: ValuationInput): string {
        const area = area_in_sqft(payload, this.book);
        const base = this.book.base_range(payload.location, payload.property_type);

        const lines = [
            "PROPERTY DETAILS",
            `Property type: ${payload.property_type}`,
            `City: ${payload.location}`,
            `Locality: ${payload.locality || "not provided"}`,
            `Address: ${payload.address || "not provided"}`,
            `Landmark: ${payload.landmark || "not provided"}`,
            `PIN code: ${payload.pincode || "not provided"}`,
            `Size band chosen by the customer: ${payload.property_size || "not provided"}`,
            `Built-up area: ${payload.built_up_area ? `${payload.built_up_area} ${payload.area_unit}` : "not provided"}`,
            `Land area: ${payload.land_area ? `${payload.land_area} ${payload.land_area_unit}` : "not provided"}`,
            `Chargeable area used for pricing: ${area ? area.toLocaleString('en-IN') + ' sq.ft' : "UNKNOWN"}`,
            `Bedrooms: ${payload.bedrooms || "not provided"}`,
            `Property age: ${payload.property_age || "not provided"}`,
            `Floor: ${payload.floor || "n/a"} of ${payload.total_floors || "n/a"}`,
            `Condition: ${payload.condition || "not provided"}`,
            `Parking: ${payload.parking || "not provided"}`,
            `Facing: ${payload.facing || "not provided"}`,
            `Road width: ${payload.road_width || "not provided"}`,
            `Amenities: ${(payload.amenities || []).join(", ") || "none recorded"}`,
            `Location features: ${(payload.location_features || []).join(", ") || "none recorded"}`,
            "",
            "DN ASSET REFERENCE RATES (the factual basis for your estimate)",
            `Source: ${this.book.source} | Last reviewed: ${this.book.last_reviewed}`,
        ];

        if (base) {
            lines.push(`Applicable band for ${payload.property_type} in ${payload.location}: ₹${base.low.toLocaleString('en-IN')} - ₹${base.high.toLocaleString('en-IN')} per sq.ft`);
            lines.push(`Published adjustment factors: ${JSON.stringify(this.book.adjustments)}`);
        } else {
            lines.push(`NO reference rate is available for ${payload.property_type} in ${payload.location}. Cities with rates: ${this.book.known_cities().join(", ") || "none"}.`);
            lines.push("You must therefore set insufficient_data to true.");
        }

        lines.push("");
        lines.push("UPLOADED MATERIAL");
        lines.push(`Property photos attached to this message: ${(payload.images || []).length}`);
        
        if (payload.documents && payload.documents.length > 0) {
            const doc_names = payload.documents.map(d => d.original_name).join(", ");
            lines.push(`Documents held on file (contents ${SEND_DOCUMENTS_TO_AI ? "attached" : "withheld for privacy"}): ${doc_names}`);
        } else {
            lines.push("Documents held on file: none");
        }

        lines.push("");
        lines.push("Produce the indicative valuation now. State clearly that this is an indicative AI estimate and not a certified valuation in your recommendation.");
        
        return lines.join("\n");
    }

    _attachments(payload: ValuationInput): any[] {
        const blocks: any[] = [];
        for (const image of (payload.images || []).slice(0, MAX_IMAGES_TO_AI)) {
            const block = this._encode(image, "image");
            if (block) blocks.push(block);
        }

        if (SEND_DOCUMENTS_TO_AI) {
            for (const doc of (payload.documents || [])) {
                if (doc.media_type === "application/pdf") {
                    const block = this._encode(doc, "document");
                    if (block) blocks.push(block);
                }
            }
        }
        return blocks;
    }

    _encode(ref: UploadRef, block_type: string): any | null {
        if (!ref.path || !fs.existsSync(ref.path)) {
            logger.warn(`Upload ${ref.file_id} missing on disk - skipped`);
            return null;
        }
        const size = fs.statSync(ref.path).size;
        if (size > MAX_BYTES_TO_AI) {
            logger.info(`Upload ${ref.file_id} is ${size} bytes - too large for the AI call`);
            return null;
        }
        const data = fs.readFileSync(ref.path).toString("base64");
        return {
            type: block_type,
            source: { type: "base64", media_type: ref.media_type, data: data },
        };
    }

    async estimate(payload: ValuationInput): Promise<ValuationResult> {
        let client: Anthropic;
        try {
            client = this._get_client();
        } catch (exc: any) {
            logger.warn(`Claude unavailable (${exc.message}) - using reference rates`);
            const result = await this.fallback.estimate(payload);
            result.provider = "reference (claude unavailable)";
            return result;
        }

        const blocks = this._attachments(payload);
        blocks.push({ type: "text", text: this._property_brief(payload) });

        let response;
        try {
            // Note: Output config (structured json) is handled differently in recent Anthropic SDKs (tool use)
            // But if it's supported directly as output_config in this version:
            const requestPayload: any = {
                model: CLAUDE_MODEL,
                max_tokens: CLAUDE_MAX_TOKENS,
                system: SYSTEM_PROMPT,
                messages: [{ role: "user", content: blocks }]
            };
            
            // For now, if output_config fails we just send it as a tool or system prompt instruction
            // This is a simplified port assuming the SDK handles this format or we adapt it to tool calling.
            // Using tool calling to enforce structure is the standard Anthropic approach in Node:
            response = await client.messages.create({
                model: CLAUDE_MODEL,
                max_tokens: CLAUDE_MAX_TOKENS,
                system: SYSTEM_PROMPT,
                messages: [{ role: "user", content: blocks }],
                tools: [{
                    name: "provide_valuation",
                    description: "Provide the valuation estimate in the structured format.",
                    input_schema: VALUATION_SCHEMA
                }],
                tool_choice: { type: "tool", name: "provide_valuation" }
            });
            
        } catch (exc: any) {
            logger.error(`Claude valuation call failed: ${exc}`);
            const result = await this.fallback.estimate(payload);
            result.provider = "reference (claude error)";
            result.raw.claude_error = String(exc).substring(0, 400);
            return result;
        }

        if (response.stop_reason === "tool_use" || response.content.some(c => c.type === "tool_use")) {
            const toolUse = response.content.find(c => c.type === "tool_use") as any;
            if (toolUse && toolUse.input) {
                return await this._to_result(toolUse.input, payload, response);
            }
        }
        
        logger.error("Claude did not return structured output");
        const result = await this.fallback.estimate(payload);
        result.provider = "reference (claude parse error)";
        return result;
    }

    async _to_result(data: Record<string, any>, payload: ValuationInput, response: any): Promise<ValuationResult> {
        const usage = response.usage || {};
        const raw: Record<string, any> = {
            engine: CLAUDE_MODEL,
            effort: CLAUDE_EFFORT,
            rate_source: this.book.source,
            rates_last_reviewed: this.book.last_reviewed,
            images_sent: Math.min((payload.images || []).length, MAX_IMAGES_TO_AI),
            documents_sent: SEND_DOCUMENTS_TO_AI ? (payload.documents || []).length : 0,
            reasoning_summary: data.reasoning_summary || "",
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
        };

        if (data.insufficient_data) {
            return {
                status: "insufficient_data",
                provider: this.name,
                message: INSUFFICIENT_MESSAGE,
                missing_information: data.missing_information || [],
                recommendation: data.recommendation || "Request a professional valuation from a DN Asset expert.",
                valuation_factors: [],
                disclaimer: DISCLAIMER,
                raw
            };
        }

        const low = parseFloat(data.estimated_low) || 0;
        const high = parseFloat(data.estimated_high) || 0;
        const mid = parseFloat(data.estimated_midpoint) || (low + high) / 2;

        if (low <= 0 || high <= 0 || high < low) {
            logger.warn(`Claude returned an invalid range (${low}-${high})`);
            const result = await this.fallback.estimate(payload);
            result.provider = "reference (invalid AI range)";
            Object.assign(result.raw, raw);
            return result;
        }

        let confidence = data.confidence_level || "Medium";
        if (confidence === "High") confidence = "Medium";

        return {
            status: "completed",
            provider: this.name,
            estimated_low: round_to(low, 10_000),
            estimated_high: round_to(high, 10_000),
            estimated_midpoint: round_to(mid, 10_000),
            price_per_sqft: Math.round(parseFloat(data.price_per_sqft || "0") * 100) / 100 || undefined,
            confidence_level: confidence,
            valuation_factors: data.valuation_factors || [],
            missing_information: data.missing_information || [],
            recommendation: data.recommendation || "",
            message: "",
            disclaimer: DISCLAIMER,
            raw
        };
    }
    
    describe() { return { provider: this.name }; }
}

const _service_cache: Record<string, AIValuationService> = {};

export function get_valuation_service(): AIValuationService {
    let key = (process.env.DN_ASSET_AI_PROVIDER || "reference").trim().toLowerCase();
    if (!["reference", "claude", "none"].includes(key)) {
        logger.warn(`Unknown DN_ASSET_AI_PROVIDER='${key}' - falling back to 'reference'`);
        key = "reference";
    }
    if (!_service_cache[key]) {
        if (key === "reference") _service_cache[key] = new ReferenceRateValuationService();
        else if (key === "claude") _service_cache[key] = new ClaudeValuationService();
        else _service_cache[key] = new NullValuationService();
    }
    return _service_cache[key];
}

export function provider_status(): Record<string, any> {
    const book = new RateBook();
    const configured = (process.env.DN_ASSET_AI_PROVIDER || "reference").trim().toLowerCase();
    const resolved = ["reference", "claude", "none"].includes(configured) ? configured : "reference";
    
    return {
        provider: resolved,
        model: resolved === "claude" ? CLAUDE_MODEL : null,
        api_key_configured: Boolean(process.env.ANTHROPIC_API_KEY),
        rate_source: book.source,
        rates_last_reviewed: book.last_reviewed,
        rate_cities: book.known_cities(),
        documents_sent_to_ai: SEND_DOCUMENTS_TO_AI,
    };
}
