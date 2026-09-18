// api/leads.js

import { supabase } from "./supabase.js";

export default async function handler(req, res) {
    try {
        // =====================================================
        // GET = Leads abrufen
        // =====================================================

        if (req.method === "GET") {
            const {
                status,
                search,
                limit = 100
            } = req.query || {};

            let query = supabase
                .from("leads")
                .select(`
                    id,
                    status,
                    priority,
                    score,
                    notes,
                    last_contacted_at,
                    next_follow_up_at,
                    created_at,
                    updated_at,
                    company:companies (
                        id,
                        name,
                        legal_name,
                        industry,
                        phone,
                        email,
                        website,
                        street,
                        house_number,
                        postal_code,
                        city,
                        country,
                        employees
                    ),
                    contact:contacts (
                        id,
                        first_name,
                        last_name,
                        job_title,
                        phone,
                        mobile,
                        email
                    )
                `)
                .order("created_at", {
                    ascending: false
                })
                .limit(Math.min(Number(limit) || 100, 500));

            // Nach Status filtern
            if (status) {
                query = query.eq("status", status);
            }

            const { data, error } = await query;

            if (error) {
                console.error("Supabase GET leads error:", error);

                return res.status(500).json({
                    success: false,
                    error: error.message
                });
            }

            let leads = data || [];

            // =================================================
            // Freitextsuche
            // =================================================

            if (search) {
                const term = search.toLowerCase().trim();

                leads = leads.filter((lead) => {
                    const company = lead.company || {};
                    const contact = lead.contact || {};

                    const values = [
                        company.name,
                        company.legal_name,
                        company.industry,
                        company.phone,
                        company.email,
                        company.website,
                        company.street,
                        company.postal_code,
                        company.city,

                        contact.first_name,
                        contact.last_name,
                        contact.phone,
                        contact.mobile,
                        contact.email
                    ];

                    return values.some((value) =>
                        String(value || "")
                            .toLowerCase()
                            .includes(term)
                    );
                });
            }

            return res.status(200).json({
                success: true,
                count: leads.length,
                leads
            });
        }

        // =====================================================
        // POST = Lead erstellen
        // =====================================================

        if (req.method === "POST") {
            const body = req.body || {};

            const {
                user_id,
                company,
                contact,
                lead
            } = body;

            if (!user_id) {
                return res.status(400).json({
                    success: false,
                    error: "user_id ist erforderlich."
                });
            }

            if (!company || !company.name) {
                return res.status(400).json({
                    success: false,
                    error: "Firmenname ist erforderlich."
                });
            }

            // =================================================
            // Unternehmen erstellen
            // =================================================

            const { data: companyData, error: companyError } =
                await supabase
                    .from("companies")
                    .insert({
                        user_id,

                        name: company.name,
                        legal_name: company.legal_name || null,

                        industry: company.industry || null,

                        phone: company.phone || null,
                        email: company.email || null,
                        website: company.website || null,

                        street: company.street || null,
                        house_number: company.house_number || null,
                        postal_code: company.postal_code || null,
                        city: company.city || null,
                        country: company.country || "Deutschland",

                        employees:
                            company.employees !== undefined
                                ? company.employees
                                : null,

                        description: company.description || null,

                        latitude:
                            company.latitude !== undefined
                                ? company.latitude
                                : null,

                        longitude:
                            company.longitude !== undefined
                                ? company.longitude
                                : null,

                        source: company.source || null,
                        source_url: company.source_url || null
                    })
                    .select()
                    .single();

            if (companyError) {
                console.error(
                    "Supabase company insert error:",
                    companyError
                );

                return res.status(500).json({
                    success: false,
                    error: companyError.message
                });
            }

            // =================================================
            // Kontakt optional erstellen
            // =================================================

            let contactData = null;

            if (contact) {
                const { data, error } = await supabase
                    .from("contacts")
                    .insert({
                        user_id,
                        company_id: companyData.id,

                        first_name: contact.first_name || null,
                        last_name: contact.last_name || null,

                        job_title: contact.job_title || null,

                        phone: contact.phone || null,
                        mobile: contact.mobile || null,
                        email: contact.email || null,

                        linkedin_url:
                            contact.linkedin_url || null,

                        notes: contact.notes || null
                    })
                    .select()
                    .single();

                if (error) {
                    console.error(
                        "Supabase contact insert error:",
                        error
                    );

                    // Unternehmen wieder löschen,
                    // wenn Kontakt-Erstellung fehlschlägt.
                    await supabase
                        .from("companies")
                        .delete()
                        .eq("id", companyData.id);

                    return res.status(500).json({
                        success: false,
                        error: error.message
                    });
                }

                contactData = data;
            }

            // =================================================
            // Lead erstellen
            // =================================================

            const leadInsert = {
                user_id,

                company_id: companyData.id,

                contact_id:
                    contactData?.id || null,

                status:
                    lead?.status ||
                    "new",

                priority:
                    lead?.priority ||
                    "normal",

                score:
                    lead?.score !== undefined
                        ? lead.score
                        : null,

                assigned_to:
                    lead?.assigned_to || null,

                notes:
                    lead?.notes || null,

                last_contacted_at:
                    lead?.last_contacted_at || null,

                next_follow_up_at:
                    lead?.next_follow_up_at || null
            };

            const { data: leadData, error: leadError } =
                await supabase
                    .from("leads")
                    .insert(leadInsert)
                    .select()
                    .single();

            if (leadError) {
                console.error(
                    "Supabase lead insert error:",
                    leadError
                );

                // Aufräumen
                if (contactData?.id) {
                    await supabase
                        .from("contacts")
                        .delete()
                        .eq("id", contactData.id);
                }

                await supabase
                    .from("companies")
                    .delete()
                    .eq("id", companyData.id);

                return res.status(500).json({
                    success: false,
                    error: leadError.message
                });
            }

            // =================================================
            // Activity automatisch anlegen
            // =================================================

            await supabase
                .from("activities")
                .insert({
                    user_id,

                    lead_id: leadData.id,
                    company_id: companyData.id,

                    contact_id:
                        contactData?.id || null,

                    type: "lead_created",

                    subject: "Lead erstellt",

                    description:
                        `Lead für ${companyData.name} wurde erstellt.`,

                    metadata: {
                        source:
                            company.source ||
                            "manual"
                    }
                });

            // =================================================
            // Ergebnis
            // =================================================

            return res.status(201).json({
                success: true,

                lead: {
                    ...leadData,

                    company: companyData,
                    contact: contactData
                }
            });
        }

        // =====================================================
        // Methode nicht unterstützt
        // =====================================================

        res.setHeader("Allow", ["GET", "POST"]);

        return res.status(405).json({
            success: false,
            error: "Method not allowed"
        });

    } catch (error) {
        console.error("Leads API error:", error);

        return res.status(500).json({
            success: false,
            error: "Interner Serverfehler."
        });
    }
}