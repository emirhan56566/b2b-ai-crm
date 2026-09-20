// api/company-import.js

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY =
    process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY =
    process.env.SUPABASE_ANON_KEY;


/* =========================================================
   SUPABASE
========================================================= */

function supabaseHeaders() {
    return {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json"
    };
}


async function getUser(req) {
    const auth =
        req.headers.authorization ||
        req.headers.Authorization;

    if (!auth?.startsWith("Bearer ")) {
        throw new Error("Nicht authentifiziert.");
    }

    const token = auth.substring(7);

    const response = await fetch(
        `${SUPABASE_URL}/auth/v1/user`,
        {
            headers: {
                apikey: SUPABASE_ANON_KEY,
                Authorization: `Bearer ${token}`
            }
        }
    );

    if (!response.ok) {
        throw new Error("Sitzung ungültig.");
    }

    return await response.json();
}


/* =========================================================
   HILFSFUNKTIONEN
========================================================= */

function clean(value) {
    const text = String(value ?? "").trim();

    if (!text) {
        return null;
    }

    const lower = text.toLowerCase();

    if (
        lower === "k. a." ||
        lower === "k.a." ||
        lower === "k a" ||
        lower === "keine angabe" ||
        lower === "nicht angegeben" ||
        lower === "-"
    ) {
        return null;
    }

    return text;
}


function normalizeKey(value) {
    return String(value || "")
        .toLowerCase()
        .replace(/ä/g, "ae")
        .replace(/ö/g, "oe")
        .replace(/ü/g, "ue")
        .replace(/ß/g, "ss")
        .replace(/[^a-z0-9]/g, "");
}


/* =========================================================
   FELDER
========================================================= */

const FIELD_NAMES = new Set(
    [
        "name",
        "firma",
        "unternehmen",
        "firmenname",

        "branche",
        "branchen",
        "industrie",
        "kategorie",

        "adresse",
        "anschrift",

        "plz",
        "postleitzahl",

        "ort",
        "stadt",

        "telefon",
        "telefonzentrale",
        "telefonzentralegeschaeftsleitung",
        "telefonnummer",
        "tel",
        "phone",
        "fon",
        "mobil",
        "mobile",

        "ansprechpartner",
        "ansprechpartnernamefunktion",
        "kontakt",
        "kontaktperson",

        "website",
        "webseite",
        "homepage",
        "url",

        "mitarbeiter",
        "mitarbeiterzahl",
        "mitarbeiteranzahl",
        "employees",

        "rechtsform",
        "unternehmensform",
        "firmenform",

        "handelsregisterstatus",
        "handelsregister",

        "energiebedarf",
        "energiebedarfe",
        "energie",

        "quelle",
        "quelleurl",
        "source",
        "sourceurl",

        "beschreibung",
        "description",
        "info"
    ].map(normalizeKey)
);


/* =========================================================
   FELDZEILE
========================================================= */

function fieldMatch(line) {
    const match = String(line || "").match(
        /^([^:]+):\s*(.*)$/
    );

    if (!match) {
        return null;
    }

    return {
        rawKey: match[1].trim(),
        key: normalizeKey(match[1]),
        value: match[2].trim()
    };
}


function isFieldLine(line) {
    const field = fieldMatch(line);

    if (!field) {
        return false;
    }

    return FIELD_NAMES.has(field.key);
}


/* =========================================================
   FIRMENNUMMER
========================================================= */

function isCompanyNumberLine(line) {
    return /^\[\d+\]\s+/.test(String(line || ""));
}


function removeCompanyNumber(line) {
    return String(line || "")
        .replace(/^\[\d+\]\s*/, "")
        .trim();
}


/* =========================================================
   FIRMENNAME
========================================================= */

function isCompanyNameLabel(line) {
    const field = fieldMatch(line);

    if (!field) {
        return false;
    }

    return [
        "name",
        "firma",
        "unternehmen",
        "firmenname"
    ].includes(field.key);
}


function guessCompanyName(lines) {
    for (const originalLine of lines) {
        const line = removeCompanyNumber(originalLine);

        if (!line) {
            continue;
        }

        if (isFieldLine(line)) {
            continue;
        }

        if (isCompanyNumberLine(originalLine)) {
            return line;
        }

        return line;
    }

    return null;
}


/* =========================================================
   UNTERNEHMENSBLÖCKE TRENNEN

   Unterstützt:

   [1] Firma A
   Branche: ...
   ...

   [2] Firma B
   Branche: ...
   ...

   Die Nummer [1], [2], [3] usw. beginnt IMMER einen
   neuen Datensatz.
========================================================= */

function splitCompanyBlocks(text) {
    const lines = String(text || "")
        .replace(/\r/g, "")
        .split("\n")
        .map(line => line.trim());

    const blocks = [];
    let current = [];

    function flush() {
        const block = current.filter(Boolean);

        if (block.length) {
            blocks.push(block);
        }

        current = [];
    }

    for (const line of lines) {
        if (!line) {
            continue;
        }

        if (isCompanyNumberLine(line)) {
            if (current.length) {
                flush();
            }

            current.push(line);
            continue;
        }

        if (isCompanyNameLabel(line)) {
            if (current.length) {
                flush();
            }

            current.push(line);
            continue;
        }

        current.push(line);
    }

    flush();

    return blocks;
}


/* =========================================================
   FELD AUS BLOCK
========================================================= */

function getField(lines, names) {
    const wanted = new Set(
        names.map(normalizeKey)
    );

    for (const line of lines) {
        const field = fieldMatch(
            removeCompanyNumber(line)
        );

        if (
            field &&
            wanted.has(field.key)
        ) {
            return field.value;
        }
    }

    return null;
}


/* =========================================================
   TELEFON

   Beispiel:

   Telefon (Zentrale/Geschäftsleitung):
   +49 2622 2442 (ungeprüft)
========================================================= */

function getPhone(lines) {
    for (const line of lines) {
        const cleanLine =
            removeCompanyNumber(line);

        const match = cleanLine.match(
            /^telefon(?:\s*\([^)]*\))?\s*:\s*(.+)$/i
        );

        if (match) {
            return clean(match[1]);
        }
    }

    for (const line of lines) {
        const cleanLine =
            removeCompanyNumber(line);

        const match = cleanLine.match(
            /^(?:tel\.?|phone|fon|mobil|mobile)(?:\s*\([^)]*\))?\s*:\s*(.+)$/i
        );

        if (match) {
            return clean(match[1]);
        }
    }

    return null;
}


/* =========================================================
   ANSPRECHPARTNER

   Beispiel:

   Hans-Peter Schiffer (Inhaber)

   wird:

   contact_name = Hans-Peter Schiffer
   contact_role = Inhaber
========================================================= */

function getContact(lines) {
    let value = null;

    for (const line of lines) {
        const cleanLine =
            removeCompanyNumber(line);

        const match = cleanLine.match(
            /^ansprechpartner(?:\s*\([^)]*\))?\s*:\s*(.+)$/i
        );

        if (match) {
            value = clean(match[1]);
            break;
        }
    }

    if (!value) {
        for (const line of lines) {
            const cleanLine =
                removeCompanyNumber(line);

            const match = cleanLine.match(
                /^(?:kontakt|kontaktperson)\s*:\s*(.+)$/i
            );

            if (match) {
                value = clean(match[1]);
                break;
            }
        }
    }

    if (!value) {
        return {
            name: null,
            role: null
        };
    }

    const roleMatch = value.match(
        /^(.+?)\s*\(([^()]*)\)\s*$/
    );

    if (roleMatch) {
        return {
            name: clean(roleMatch[1]),
            role: clean(roleMatch[2])
        };
    }

    return {
        name: clean(value),
        role: null
    };
}


/* =========================================================
   MITARBEITER

   Beispiele:

   k. A.
   ca. 15
   ca. 10–25 (ungeprüft)

   Speicherung:
   employees = Zahl
========================================================= */

function parseEmployees(value) {
    const raw = clean(value);

    if (!raw) {
        return null;
    }

    const range = raw.match(
        /(\d+)\s*(?:-|–|—|bis)\s*(\d+)/
    );

    if (range) {
        const min = Number(range[1]);
        const max = Number(range[2]);

        if (
            Number.isFinite(min) &&
            Number.isFinite(max)
        ) {
            return Math.round(
                (min + max) / 2
            );
        }
    }

    const single = raw.match(/\b(\d+)\b/);

    if (!single) {
        return null;
    }

    const number = Number(single[1]);

    return Number.isFinite(number)
        ? number
        : null;
}


/* =========================================================
   RECHTSFORM
========================================================= */

function detectLegalForm(text) {
    const value =
        String(text || "").toLowerCase();

    if (value.includes("gmbh & co")) {
        return "GmbH & Co. KG";
    }

    if (value.includes("einzelunternehmen")) {
        return "Einzelunternehmen";
    }

    if (/\be\.?\s*k\.?\b/.test(value)) {
        return "e.K.";
    }

    if (/\bgmbh\b/.test(value)) {
        return "GmbH";
    }

    if (/\bug\b/.test(value)) {
        return "UG";
    }

    if (/\bag\b/.test(value)) {
        return "AG";
    }

    if (/\bohg\b/.test(value)) {
        return "OHG";
    }

    if (/\bkg\b/.test(value)) {
        return "KG";
    }

    if (/\bgbr\b/.test(value)) {
        return "GbR";
    }

    return null;
}


/* =========================================================
   ENERGIEBEDARF

   Beispiel:

   Energiebedarf (hoch/mittel/niedrig, kurze Begründung):
   hoch (Backöfen, Teigknetmaschinen und Kühlung)

   Speicherung:

   energy_need = hoch
========================================================= */

function getEnergy(lines) {
    let value = null;

    for (const line of lines) {
        const cleanLine =
            removeCompanyNumber(line);

        const match = cleanLine.match(
            /^energiebedarf(?:\s*\([^)]*\))?\s*:\s*(.+)$/i
        );

        if (match) {
            value = clean(match[1]);
            break;
        }
    }

    if (!value) {
        return null;
    }

    const match = value.match(
        /^(hoch|mittel|niedrig)\b/i
    );

    if (!match) {
        return null;
    }

    return match[1].toLowerCase();
}


/* =========================================================
   ENERGIEBEGRÜNDUNG
========================================================= */

function getEnergyReason(lines) {
    let value = null;

    for (const line of lines) {
        const cleanLine =
            removeCompanyNumber(line);

        const match = cleanLine.match(
            /^energiebedarf(?:\s*\([^)]*\))?\s*:\s*(.+)$/i
        );

        if (match) {
            value = clean(match[1]);
            break;
        }
    }

    if (!value) {
        return null;
    }

    const match = value.match(
        /^(hoch|mittel|niedrig)\s*(?:\((.*)\))?$/i
    );

    if (match) {
        return clean(match[2]);
    }

    return clean(
        value
            .replace(
                /^(hoch|mittel|niedrig)\s*/i,
                ""
            )
            .replace(/^\(/, "")
            .replace(/\)$/, "")
    );
}


/* =========================================================
   QUELLE
========================================================= */

function getSourceUrl(lines) {
    const value = getField(
        lines,
        [
            "quelle",
            "quelleurl",
            "source",
            "sourceurl"
        ]
    );

    if (!value) {
        return null;
    }

    const urlMatch = value.match(
        /https?:\/\/[^\s)]+/i
    );

    if (urlMatch) {
        return urlMatch[0];
    }

    return clean(value);
}


/* =========================================================
   UNTERNEHMEN PARSEN
========================================================= */

function parseCompany(block) {
    const lines =
        block.map(removeCompanyNumber);

    const name =
        getField(
            lines,
            [
                "name",
                "firma",
                "unternehmen",
                "firmenname"
            ]
        ) ||
        guessCompanyName(lines);

    if (!name) {
        return null;
    }

    const employees =
        parseEmployees(
            getField(
                lines,
                [
                    "mitarbeiter",
                    "mitarbeiterzahl",
                    "mitarbeiteranzahl",
                    "employees"
                ]
            )
        );

    const legalForm =
        getField(
            lines,
            [
                "rechtsform",
                "unternehmensform",
                "firmenform"
            ]
        ) ||
        detectLegalForm(
            lines.join(" ")
        );

    const contact =
        getContact(lines);

    const energyNeed =
        getEnergy(lines);

    const energyReason =
        getEnergyReason(lines);

    return {
        name: clean(name),

        address: clean(
            getField(
                lines,
                [
                    "adresse",
                    "anschrift"
                ]
            )
        ),

        postal_code: clean(
            getField(
                lines,
                [
                    "plz",
                    "postleitzahl"
                ]
            )
        ),

        city: clean(
            getField(
                lines,
                [
                    "ort",
                    "stadt"
                ]
            )
        ),

        phone:
            getPhone(lines),

        contact_name:
            contact.name,

        contact_role:
            contact.role,

        website: clean(
            getField(
                lines,
                [
                    "website",
                    "webseite",
                    "homepage",
                    "url"
                ]
            )
        ),

        industry: clean(
            getField(
                lines,
                [
                    "branche",
                    "branchen",
                    "industrie",
                    "kategorie"
                ]
            )
        ),

        employees,

        legal_form:
            clean(legalForm),

        energy_need:
            energyNeed,

        energy_reason:
            energyReason,

        source_url:
            getSourceUrl(lines),

        handelsregister_status:
            clean(
                getField(
                    lines,
                    [
                        "handelsregisterstatus",
                        "handelsregister"
                    ]
                )
            )
    };
}


/* =========================================================
   DUPLIKAT-VERGLEICH
========================================================= */

function normalizeText(value) {
    return String(value || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(
            /[\u0300-\u036f]/g,
            ""
        )
        .replace(/ä/g, "ae")
        .replace(/ö/g, "oe")
        .replace(/ü/g, "ue")
        .replace(/ß/g, "ss")
        .replace(
            /[^a-z0-9]/g,
            ""
        );
}


function normalizePhone(value) {
    return String(value || "")
        .replace(/\D/g, "");
}


function normalizeWebsite(value) {
    return String(value || "")
        .toLowerCase()
        .trim()
        .replace(/^https?:\/\//, "")
        .replace(/^www\./, "")
        .replace(/\/$/, "");
}


function sameCompany(a, b) {
    const nameA =
        normalizeText(a.name);

    const nameB =
        normalizeText(b.name);

    if (
        !nameA ||
        !nameB ||
        nameA !== nameB
    ) {
        return false;
    }

    const postalA =
        normalizeText(a.postal_code);

    const postalB =
        normalizeText(b.postal_code);

    const cityA =
        normalizeText(a.city);

    const cityB =
        normalizeText(b.city);

    const addressA =
        normalizeText(a.address);

    const addressB =
        normalizeText(b.address);

    const phoneA =
        normalizePhone(a.phone);

    const phoneB =
        normalizePhone(b.phone);

    const websiteA =
        normalizeWebsite(a.website);

    const websiteB =
        normalizeWebsite(b.website);

    if (
        addressA &&
        addressB &&
        addressA === addressB
    ) {
        return true;
    }

    if (
        postalA &&
        postalB &&
        cityA &&
        cityB &&
        postalA === postalB &&
        cityA === cityB
    ) {
        return true;
    }

    if (
        phoneA &&
        phoneB &&
        phoneA === phoneB
    ) {
        return true;
    }

    if (
        websiteA &&
        websiteB &&
        websiteA === websiteB
    ) {
        return true;
    }

    if (
        !postalA &&
        !postalB &&
        !cityA &&
        !cityB &&
        !addressA &&
        !addressB &&
        !phoneA &&
        !phoneB &&
        !websiteA &&
        !websiteB
    ) {
        return true;
    }

    return false;
}


/* =========================================================
   BESTEHENDE FIRMEN LADEN
========================================================= */

async function getExistingCompanies(userId) {
    const response = await fetch(
        `${SUPABASE_URL}/rest/v1/companies` +
        `?user_id=eq.${encodeURIComponent(userId)}` +
        `&select=*`,
        {
            headers:
                supabaseHeaders()
        }
    );

    if (!response.ok) {
        const text =
            await response.text();

        throw new Error(
            text ||
            "Bestehende Unternehmen konnten nicht geladen werden."
        );
    }

    return await response.json();
}


/* =========================================================
   FIRMA SPEICHERN
========================================================= */

async function insertCompany(
    userId,
    company
) {
    const response =
        await fetch(
            `${SUPABASE_URL}/rest/v1/companies`,
            {
                method: "POST",

                headers: {
                    ...supabaseHeaders(),

                    Prefer:
                        "return=representation"
                },

                body:
                    JSON.stringify({
                        user_id:
                            userId,

                        ...company
                    })
            }
        );

    const text =
        await response.text();

    if (!response.ok) {
        throw new Error(
            text ||
            "Unternehmen konnte nicht gespeichert werden."
        );
    }

    let rows;

    try {
        rows =
            JSON.parse(text);
    } catch {
        rows = [];
    }

    return rows[0] || {
    ...company,
    user_id: userId
};


/* =========================================================
   API
========================================================= */

export default async function handler(
    req,
    res
) {
    if (req.method !== "POST") {
        return res.status(405).json({
            error:
                "Method Not Allowed"
        });
    }

    try {
        const user =
            await getUser(req);

        const body =
            typeof req.body === "string"
                ? JSON.parse(req.body)
                : req.body || {};

        const text =
            String(
                body.text || ""
            ).trim();

        if (!text) {
            return res.status(400).json({
                error:
                    "Keine Unternehmensdaten übergeben."
            });
        }

        const blocks =
            splitCompanyBlocks(text);

        if (!blocks.length) {
            return res.status(400).json({
                error:
                    "Keine Unternehmensdatensätze erkannt."
            });
        }

        const existingCompanies =
            await getExistingCompanies(
                user.id
            );

        let imported = 0;
        let duplicates = 0;
        let invalid = 0;

        const errors = [];

        for (
            let index = 0;
            index < blocks.length;
            index++
        ) {
            try {
                const company =
                    parseCompany(
                        blocks[index]
                    );

                if (!company?.name) {
                    invalid++;

                    errors.push({
                        index:
                            index + 1,

                        error:
                            "Firmenname konnte nicht erkannt werden."
                    });

                    continue;
                }

                const duplicate =
                    existingCompanies.some(
                        existing =>
                            sameCompany(
                                existing,
                                company
                            )
                    );

                if (duplicate) {
                    duplicates++;
                    continue;
                }

                const saved =
    await insertCompany(
        user.id,
        company
    );

existingCompanies.push(
    saved
);

imported++;

            } catch (error) {
                invalid++;

                errors.push({
                    index:
                        index + 1,

                    error:
                        error?.message ||
                        "Datensatz konnte nicht gespeichert werden."
                });
            }
        }

        return res.status(200).json({
            success: true,
            imported,
            duplicates,
            invalid,
            total_blocks:
                blocks.length,
            saved:
                imported,
            errors
        });

    } catch (error) {
        console.error(
            "Company import error:",
            error
        );

        return res.status(500).json({
            error:
                error?.message ||
                "Unternehmen konnten nicht importiert werden."
        });
    }
}