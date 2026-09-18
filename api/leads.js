// api/leads.js

import { supabase } from "./supabase.js";

async function authenticate(req) {
  const authorization = req.headers.authorization || "";

  if (!authorization.startsWith("Bearer ")) {
    return {
      user: null,
      error: "Nicht authentifiziert."
    };
  }

  const token = authorization.substring(7).trim();

  if (!token) {
    return {
      user: null,
      error: "Kein Access Token vorhanden."
    };
  }

  const response = await fetch(
    `${process.env.SUPABASE_URL}/auth/v1/user`,
    {
      method: "GET",
      headers: {
        apikey: process.env.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`
      }
    }
  );

  if (!response.ok) {
    return {
      user: null,
      error: "Ungültige oder abgelaufene Sitzung."
    };
  }

  const user = await response.json();

  if (!user?.id) {
    return {
      user: null,
      error: "Benutzer konnte nicht ermittelt werden."
    };
  }

  return {
    user,
    error: null
  };
}

export default async function handler(req, res) {
  try {
    const { user, error: authError } = await authenticate(req);

    if (!user) {
      return res.status(401).json({
        success: false,
        error: authError || "Nicht authentifiziert."
      });
    }

    // GET /api/leads
    if (req.method === "GET") {
      const status = req.query?.status;
      const search = req.query?.search;
      const limit = Math.min(
        Number(req.query?.limit) || 100,
        500
      );

      let query = supabase
        .from("leads")
        .select(`
          id,
          status,
          priority,
          score,
          notes,
          created_at,
          updated_at,
          company_id,
          contact_id,
          assigned_to,
          companies (
            id,
            name,
            legal_name,
            industry,
            website,
            phone,
            email,
            address,
            postal_code,
            city,
            country,
            employee_count
          ),
          contacts (
            id,
            first_name,
            last_name,
            job_title,
            email,
            phone,
            mobile,
            linkedin_url
          )
        `)
        .eq("user_id", user.id)
        .order("created_at", {
          ascending: false
        })
        .limit(limit);

      if (status) {
        query = query.eq("status", status);
      }

      const { data: leads, error } = await query;

      if (error) {
        console.error("GET leads error:", error);

        return res.status(500).json({
          success: false,
          error: error.message
        });
      }

      let result = leads || [];

      if (search) {
        const term = String(search)
          .trim()
          .toLowerCase();

        if (term) {
          result = result.filter((lead) => {
            const company = lead.companies || {};
            const contact = lead.contacts || {};

            const searchable = [
              company.name,
              company.legal_name,
              company.industry,
              company.phone,
              company.email,
              company.address,
              company.postal_code,
              company.city,
              contact.first_name,
              contact.last_name,
              contact.job_title,
              contact.email,
              contact.phone,
              lead.status
            ]
              .filter(Boolean)
              .join(" ")
              .toLowerCase();

            return searchable.includes(term);
          });
        }
      }

      return res.status(200).json({
        success: true,
        leads: result,
        count: result.length
      });
    }

    // POST /api/leads
    if (req.method === "POST") {
      const body =
        typeof req.body === "string"
          ? JSON.parse(req.body)
          : req.body || {};

      const companyData = body.company || {};
      const contactData = body.contact || {};
      const leadData = body.lead || {};

      if (!companyData.name) {
        return res.status(400).json({
          success: false,
          error: "Firmenname fehlt."
        });
      }

      const normalizedName = String(companyData.name)
        .trim()
        .toLowerCase();

      const {
        data: existingCompanies,
        error: companySearchError
      } = await supabase
        .from("companies")
        .select("*")
        .eq("user_id", user.id)
        .limit(500);

      if (companySearchError) {
        return res.status(500).json({
          success: false,
          error: companySearchError.message
        });
      }

      let company =
        (existingCompanies || []).find(
          (item) =>
            String(item.name || "")
              .trim()
              .toLowerCase() === normalizedName
        ) || null;

      if (!company) {
        const {
          data,
          error
        } = await supabase
          .from("companies")
          .insert({
            user_id: user.id,
            name: companyData.name,
            legal_name: companyData.legal_name || null,
            industry: companyData.industry || null,
            website: companyData.website || null,
            phone: companyData.phone || null,
            email: companyData.email || null,
            address: companyData.address || null,
            postal_code: companyData.postal_code || null,
            city: companyData.city || null,
            country: companyData.country || "Deutschland",
            employee_count:
              companyData.employee_count || null
          })
          .select()
          .single();

        if (error) {
          return res.status(500).json({
            success: false,
            error: error.message
          });
        }

        company = data;
      }

      let contact = null;

      const hasContact =
        contactData.first_name ||
        contactData.last_name ||
        contactData.email ||
        contactData.phone ||
        contactData.mobile;

      if (hasContact) {
        const {
          data,
          error
        } = await supabase
          .from("contacts")
          .insert({
            user_id: user.id,
            company_id: company.id,
            first_name: contactData.first_name || null,
            last_name: contactData.last_name || null,
            job_title: contactData.job_title || null,
            email: contactData.email || null,
            phone: contactData.phone || null,
            mobile: contactData.mobile || null,
            linkedin_url:
              contactData.linkedin_url || null
          })
          .select()
          .single();

        if (error) {
          return res.status(500).json({
            success: false,
            error: error.message
          });
        }

        contact = data;
      }

      const {
        data: lead,
        error: leadError
      } = await supabase
        .from("leads")
        .insert({
          user_id: user.id,
          company_id: company.id,
          contact_id: contact?.id || null,
          status: leadData.status || "new",
          priority: leadData.priority || "normal",
          score: leadData.score ?? null,
          notes: leadData.notes || null,
          assigned_to: user.id
        })
        .select(`
          *,
          companies (
            id,
            name,
            legal_name,
            industry,
            website,
            phone,
            email,
            address,
            postal_code,
            city,
            country,
            employee_count
          ),
          contacts (
            id,
            first_name,
            last_name,
            job_title,
            email,
            phone,
            mobile,
            linkedin_url
          )
        `)
        .single();

      if (leadError) {
        return res.status(500).json({
          success: false,
          error: leadError.message
        });
      }

      await supabase
        .from("activities")
        .insert({
          user_id: user.id,
          lead_id: lead.id,
          company_id: company.id,
          contact_id: contact?.id || null,
          type: "lead_created",
          subject: "Lead erstellt",
          description:
            `Lead für ${company.name} wurde erstellt.`
        });

      return res.status(201).json({
        success: true,
        lead
      });
    }

    return res.status(405).json({
      success: false,
      error: "Method not allowed"
    });

  } catch (error) {
    console.error("Leads API error:", error);

    return res.status(500).json({
      success: false,
      error: error.message || "Interner Serverfehler."
    });
  }
}