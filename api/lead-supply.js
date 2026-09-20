import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;

const supabaseAdmin = createClient(
  SUPABASE_URL,
  SERVICE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

const ALLOWED_FIELDS = [
  "delivery_start_date",
  "company_name",
  "business_address",
  "vat_id",
  "malo_id",
  "meter_number",
  "annual_consumption_kwh",
  "current_meter_reading",
  "previous_supplier",
  "previous_customer_number",
  "iban",
  "desired_delivery_date",
  "old_contract_deadline",
  "old_contract_notice",
  "next_offer_date",
  "next_cancellation_date",
  "supply_type",
  "notes"
];

function getBearerToken(req) {
  const authHeader = req.headers.authorization || "";

  if (!authHeader.startsWith("Bearer ")) {
    return null;
  }

  return authHeader.slice(7).trim();
}

async function getUser(req) {
  const token = getBearerToken(req);

  if (!token) {
    return null;
  }

  try {
    const response = await fetch(
      `${SUPABASE_URL}/auth/v1/user`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          apikey: ANON_KEY
        }
      }
    );

    if (!response.ok) {
      return null;
    }

    return await response.json();
  } catch (error) {
    console.error("getUser error:", error);
    return null;
  }
}

async function verifyLeadOwnership(userId, leadId) {
  if (!userId || !leadId) {
    return false;
  }

  const { data, error } = await supabaseAdmin
    .from("leads")
    .select("id")
    .eq("id", leadId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    console.error("verifyLeadOwnership error:", error);
    return false;
  }

  return !!data;
}

function buildPayload(body) {
  const payload = {};

  for (const field of ALLOWED_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      payload[field] = body[field];
    }
  }

  return payload;
}

function isValidDate(value) {
  if (value === null || value === undefined || value === "") {
    return true;
  }

  if (typeof value !== "string") {
    return false;
  }

  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function validatePayload(payload) {
  if (
    payload.malo_id !== undefined &&
    payload.malo_id !== null &&
    payload.malo_id !== ""
  ) {
    const malo = String(payload.malo_id).trim();

    if (!/^\d{11}$/.test(malo)) {
      return "Die MaLo-ID muss genau 11 Ziffern enthalten.";
    }

    payload.malo_id = malo;
  }

  if (
    payload.supply_type !== undefined &&
    payload.supply_type !== null &&
    payload.supply_type !== ""
  ) {
    const allowedSupplyTypes = [
      "Strom",
      "Gas",
      "Strom + Gas",
      "strom",
      "gas",
      "beides"
    ];

    if (!allowedSupplyTypes.includes(String(payload.supply_type))) {
      return "Ungültige Lieferart.";
    }
  }

  if (
    payload.annual_consumption_kwh !== undefined &&
    payload.annual_consumption_kwh !== null &&
    payload.annual_consumption_kwh !== ""
  ) {
    const value = Number(payload.annual_consumption_kwh);

    if (!Number.isFinite(value) || value < 0) {
      return "Der Jahresverbrauch muss eine gültige Zahl sein.";
    }

    payload.annual_consumption_kwh = value;
  }

  if (
    payload.current_meter_reading !== undefined &&
    payload.current_meter_reading !== null &&
    payload.current_meter_reading !== ""
  ) {
    const value = Number(payload.current_meter_reading);

    if (!Number.isFinite(value) || value < 0) {
      return "Der aktuelle Zählerstand muss eine gültige Zahl sein.";
    }

    payload.current_meter_reading = value;
  }

  const dateFields = [
    "delivery_start_date",
    "desired_delivery_date",
    "old_contract_deadline",
    "next_offer_date",
    "next_cancellation_date"
  ];

  for (const field of dateFields) {
    if (!isValidDate(payload[field])) {
      return `${field} muss ein gültiges Datum im Format YYYY-MM-DD sein.`;
    }
  }

  return null;
}

export default async function handler(req, res) {
  try {
    const user = await getUser(req);

    if (!user?.id) {
      return res.status(401).json({
        error: "Nicht authentifiziert."
      });
    }

    const userId = user.id;

    if (req.method === "GET") {
      const leadId = req.query?.lead_id || null;

      let query = supabaseAdmin
        .from("lead_supply")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", {
          ascending: false
        });

      if (leadId) {
        const ownsLead = await verifyLeadOwnership(
          userId,
          leadId
        );

        if (!ownsLead) {
          return res.status(403).json({
            error: "Kein Zugriff auf diesen Lead."
          });
        }

        query = query.eq("lead_id", leadId);
      }

      const { data, error } = await query;

      if (error) {
        console.error("GET lead_supply error:", error);

        return res.status(500).json({
          error: error.message
        });
      }

      return res.status(200).json({
        supplies: data || []
      });
    }

    if (req.method === "POST") {
      const body = req.body || {};
      const leadId = body.lead_id || null;

      if (!leadId) {
        return res.status(400).json({
          error: "lead_id fehlt."
        });
      }

      const ownsLead = await verifyLeadOwnership(
        userId,
        leadId
      );

      if (!ownsLead) {
        return res.status(403).json({
          error: "Kein Zugriff auf diesen Lead."
        });
      }

      const payload = buildPayload(body);

      const validationError = validatePayload(payload);

      if (validationError) {
        return res.status(400).json({
          error: validationError
        });
      }

      payload.lead_id = leadId;
      payload.user_id = userId;

      const { data, error } = await supabaseAdmin
        .from("lead_supply")
        .upsert(payload, {
          onConflict: "lead_id"
        })
        .select("*")
        .single();

      if (error) {
        console.error("POST lead_supply error:", error);

        return res.status(500).json({
          error: error.message
        });
      }

      // Sobald ein Lead in "Belieferung" gespeichert wird,
      // bekommt der zugehörige Lead den Status "signed".
      const { error: leadUpdateError } =
        await supabaseAdmin
          .from("leads")
          .update({
            status: "signed"
          })
          .eq("id", leadId)
          .eq("user_id", userId);

      if (leadUpdateError) {
        console.error(
          "Lead status update error:",
          leadUpdateError
        );
      }

      return res.status(200).json({
        supply: data
      });
    }

    if (req.method === "PATCH") {
      const body = req.body || {};
      const leadId =
        body.lead_id ||
        req.query?.lead_id ||
        null;

      if (!leadId) {
        return res.status(400).json({
          error: "lead_id fehlt."
        });
      }

      const ownsLead = await verifyLeadOwnership(
        userId,
        leadId
      );

      if (!ownsLead) {
        return res.status(403).json({
          error: "Kein Zugriff auf diesen Lead."
        });
      }

      const payload = buildPayload(body);

      const validationError = validatePayload(payload);

      if (validationError) {
        return res.status(400).json({
          error: validationError
        });
      }

      delete payload.lead_id;
      delete payload.user_id;

      const { data, error } = await supabaseAdmin
        .from("lead_supply")
        .update(payload)
        .eq("lead_id", leadId)
        .eq("user_id", userId)
        .select("*")
        .single();

      if (error) {
        console.error(
          "PATCH lead_supply error:",
          error
        );

        return res.status(500).json({
          error: error.message
        });
      }

      return res.status(200).json({
        supply: data
      });
    }

    if (req.method === "DELETE") {
      const leadId =
        req.query?.lead_id ||
        req.body?.lead_id ||
        null;

      if (!leadId) {
        return res.status(400).json({
          error: "lead_id fehlt."
        });
      }

      const ownsLead = await verifyLeadOwnership(
        userId,
        leadId
      );

      if (!ownsLead) {
        return res.status(403).json({
          error: "Kein Zugriff auf diesen Lead."
        });
      }

      const { error } = await supabaseAdmin
        .from("lead_supply")
        .delete()
        .eq("lead_id", leadId)
        .eq("user_id", userId);

      if (error) {
        console.error(
          "DELETE lead_supply error:",
          error
        );

        return res.status(500).json({
          error: error.message
        });
      }

      return res.status(200).json({
        success: true
      });
    }

    return res.status(405).json({
      error: "Methode nicht erlaubt."
    });
  } catch (error) {
    console.error("lead-supply API error:", error);

    return res.status(500).json({
      error: "Interner Serverfehler."
    });
  }
}