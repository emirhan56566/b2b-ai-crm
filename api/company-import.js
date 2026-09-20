// api/company-import.js

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY =
    process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY =
    process.env.SUPABASE_ANON_KEY;


function supabaseHeaders() {
    return {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization:
            `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json"
    };
}


async function getUser(req) {
    const auth =
        req.headers.authorization ||
        req.headers.Authorization;

    if (!auth?.startsWith("Bearer ")) {
        throw new Error(
            "Nicht authentifiziert."
        );
    }

    const token =
        auth.substring(7);

    const response =
        await fetch(
            `${SUPABASE_URL}/auth/v1/user`,
            {
                headers: {
                    apikey:
                        SUPABASE_ANON_KEY,
                    Authorization:
                        `Bearer ${token}`
                }
            }
        );

    if (!response.ok) {
        throw new Error(
            "Sitzung ungültig."
        );
    }

    return await response.json();
}


function clean(value) {
    const text =
        String(value ?? "").trim();

    return text || null;
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


const FIELD_NAMES = new Set(
    [
        "name",
        "firma",
        "unternehmen",
        "firmenname",

        "adresse",
        "anschrift",

        "plz",
        "postleitzahl",

        "ort",
        "stadt",

        "telefon",
        "tel",
        "phone",
        "telefonnummer",

        "website",
        "webseite",
        "homepage",
        "url",

        "branche",
        "branchen",
        "industrie",
        "kategorie",

        "mitarbeiter",
        "mitarbeiterzahl",
        "employees",

        "rechtsform",
        "unternehmensform",
        "firmenform",

        "beschreibung",
        "description",
        "info"
    ].map(normalizeKey)
);


function fieldMatch(line) {
    const match =
        String(line || "").match(
            /^([^:]+):\s*(.+)$/
        );

    if (!match) {
        return null;
    }

    return {
        key: normalizeKey(match[1]),
        value: match[2].trim()
    };
}


function isCompanyNameLabel(line) {
    const field =
        fieldMatch(line);

    return (
        !!field &&
        [
            "name",
            "firma",
            "unternehmen",
            "firmenname"
        ].includes(field.key)
    );
}


function isFieldLine(line) {
    const field =
        fieldMatch(line);

    return (
        !!field &&
        FIELD_NAMES.has(field.key)
    );
}


/*
==================================================
UNTERNEHMENSBLÖCKE ERKENNEN
==================================================

Unterstützt zum Beispiel:

Firma A GmbH
Branche: Sanitär
Ort: Koblenz

Firma B GmbH
Branche: Maschinenbau
Ort: Bonn


sowie:

Name: Firma A GmbH
Branche: Sanitär
...

Name: Firma B GmbH
Branche: Maschinenbau
...
*/

function splitCompanyBlocks(text) {
    const lines =
        String(text || "")
            .replace(/\r/g, "")
            .split("\n")
            .map(line => line.trim());

    const blocks = [];

    let current = [];


    function flush() {
        const block =
            current.filter(Boolean);

        if (block.length) {
            blocks.push(block);
        }

        current = [];
    }


    for (
        let i = 0;
        i < lines.length;
        i++
    ) {
        const line =
            lines[i];


        /*
        Leerzeile = neuer Datensatz
        */
        if (!line) {
            flush();
            continue;
        }


        /*
        Explizites Name/Firma-Feld
        = immer neuer Datensatz
        */
        if (
            isCompanyNameLabel(line)
        ) {
            if (current.length) {
                flush();
            }

            current.push(line);
            continue;
        }


        /*
        Bare Company Name:

        Wenn bereits Felder vorhanden sind
        und die nächste Zeile ein Feld ist,
        beginnt hier ein neues Unternehmen.
        */
        if (current.length) {
            const hasName =
                current.some(
                    item =>
                        isCompanyNameLabel(item) ||
                        (
                            !isFieldLine(item) &&
                            item.length > 1
                        )
                );

            const next =
                lines[i + 1] || "";


            if (
                !isFieldLine(line) &&
                hasName &&
                next &&
                isFieldLine(next)
            ) {
                flush();
            }
        }


        current.push(line);
    }


    flush();


    /*
    Sicherheits-Fallback:

    Falls alles ohne Leerzeilen eingefügt wurde
    und mehrere Branchen vorhanden sind,
    versuchen wir anhand neuer Unternehmensnamen
    nochmals zu trennen.
    */
    if (blocks.length === 1) {
        const block =
            blocks[0];

        const industryCount =
            block.filter(line => {
                const field =
                    fieldMatch(line);

                return (
                    field &&
                    [
                        "branche",
                        "branchen",
                        "industrie",
                        "kategorie"
                    ].includes(field.key)
                );
            }).length;


        if (industryCount > 1) {
            const rebuilt = [];
            let part = [];


            for (const line of block) {
                const startsNewCompany =
                    !isFieldLine(line) &&
                    part.length > 0 &&
                    part.some(
                        item =>
                            isFieldLine(item)
                    );


                if (startsNewCompany) {
                    rebuilt.push(part);
                    part = [];
                }


                part.push(line);
            }


            if (part.length) {
                rebuilt.push(part);
            }


            if (rebuilt.length > 1) {
                return rebuilt;
            }
        }
    }


    return blocks;
}


/*
==================================================
FELD AUS DATENSATZ LESEN
==================================================
*/

function getField(lines, names) {
    const wanted =
        new Set(
            names.map(normalizeKey)
        );


    for (const line of lines) {
        const field =
            fieldMatch(line);

        if (
            field &&
            wanted.has(field.key)
        ) {
            return field.value;
        }
    }


    return null;
}


/*
==================================================
FIRMENNAMEN ERKENNEN
==================================================
*/

function guessCompanyName(lines) {
    for (const line of lines) {
        if (!line) {
            continue;
        }

        if (isFieldLine(line)) {
            continue;
        }

        if (line.length > 1) {
            return line.trim();
        }
    }

    return null;
}


/*
==================================================
RECHTSFORM ERKENNEN
==================================================
*/

function detectLegalForm(text) {
    const value =
        String(text || "")
            .toLowerCase();


    if (
        /\be\.?\s*k\.?\b/.test(value)
    ) {
        return "e.K.";
    }


    if (
        value.includes(
            "einzelunternehmen"
        )
    ) {
        return "Einzelunternehmen";
    }


    if (
        value.includes(
            "gmbh & co"
        )
    ) {
        return "GmbH & Co. KG";
    }


    if (
        value.includes("gmbh")
    ) {
        return "GmbH";
    }


    if (
        /\bug\b/.test(value)
    ) {
        return "UG";
    }


    if (
        /\bag\b/.test(value)
    ) {
        return "AG";
    }


    if (
        /\bohg\b/.test(value)
    ) {
        return "OHG";
    }


    if (
        /\bkg\b/.test(value)
    ) {
        return "KG";
    }


    if (
        /\bgbr\b/.test(value)
    ) {
        return "GbR";
    }


    return null;
}


/*
==================================================
UNTERNEHMEN PARSEN
==================================================
*/

function parseCompany(block) {
    const joined =
        block.join(" ");


    const name =
        getField(
            block,
            [
                "name",
                "firma",
                "unternehmen",
                "firmenname"
            ]
        ) ||
        guessCompanyName(block);


    if (!name) {
        return null;
    }


    const employeesRaw =
        getField(
            block,
            [
                "mitarbeiter",
                "mitarbeiterzahl",
                "employees"
            ]
        );


    let employees = null;


    if (employeesRaw) {
        const match =
            String(employeesRaw)
                .replace(/\./g, "")
                .replace(",", ".")
                .match(
                    /\d+(?:\.\d+)?/
                );


        if (match) {
            employees =
                Number(match[0]) || null;
        }
    }


    const legalForm =
        getField(
            block,
            [
                "rechtsform",
                "unternehmensform",
                "firmenform"
            ]
        ) ||
        detectLegalForm(joined);


    return {
        name:
            clean(name),

        legal_name:
            clean(name),

        address:
            clean(
                getField(
                    block,
                    [
                        "adresse",
                        "anschrift"
                    ]
                )
            ),

        postal_code:
            clean(
                getField(
                    block,
                    [
                        "plz",
                        "postleitzahl"
                    ]
                )
            ),

        city:
            clean(
                getField(
                    block,
                    [
                        "ort",
                        "stadt"
                    ]
                )
            ),

        phone:
            clean(
                getField(
                    block,
                    [
                        "telefon",
                        "tel",
                        "phone",
                        "telefonnummer"
                    ]
                )
            ),

        website:
            clean(
                getField(
                    block,
                    [
                        "website",
                        "webseite",
                        "homepage",
                        "url"
                    ]
                )
            ),

        industry:
            clean(
                getField(
                    block,
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

        description:
            clean(
                getField(
                    block,
                    [
                        "beschreibung",
                        "description",
                        "info"
                    ]
                )
            )
    };
}


/*
==================================================
DUPLIKAT-VERGLEICH
==================================================

Wichtig:
Nur gleicher Name reicht NICHT automatisch.

Dadurch werden z.B.

Müller GmbH - Koblenz
Müller GmbH - Bonn

nicht einfach als dasselbe Unternehmen
behandelt.
*/

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
        .replace(
            /^https?:\/\//,
            ""
        )
        .replace(
            /^www\./,
            ""
        )
        .replace(
            /\/$/,
            ""
        );
}


function sameCompany(a, b) {
    const nameA =
        normalizeText(a.name);

    const nameB =
        normalizeText(b.name);


    /*
    Ohne gleichen Namen
    niemals Duplikat.
    */
    if (
        !nameA ||
        !nameB ||
        nameA !== nameB
    ) {
        return false;
    }


    const postalA =
        normalizeText(
            a.postal_code
        );

    const postalB =
        normalizeText(
            b.postal_code
        );

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


    /*
    Gleiche exakte Adresse
    */
    if (
        addressA &&
        addressB &&
        addressA === addressB
    ) {
        return true;
    }


    /*
    Gleiche PLZ + gleicher Ort
    */
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


    /*
    Gleiche Telefonnummer
    */
    if (
        phoneA &&
        phoneB &&
        phoneA === phoneB
    ) {
        return true;
    }


    /*
    Gleiche Website
    */
    if (
        websiteA &&
        websiteB &&
        websiteA === websiteB
    ) {
        return true;
    }


    /*
    Wenn keinerlei weitere Daten vorhanden sind,
    gilt der exakt gleiche normalisierte Name
    als Duplikat.
    */
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


/*
==================================================
BESTEHENDE UNTERNEHMEN EINMAL LADEN
==================================================
*/

async function getExistingCompanies(userId) {
    const response =
        await fetch(
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


/*
==================================================
UNTERNEHMEN SPEICHERN
==================================================
*/

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


    const rows =
        JSON.parse(text);


    return rows[0];
}


/*
==================================================
API HANDLER
==================================================
*/

export default async function handler(
    req,
    res
) {
    if (
        req.method !== "POST"
    ) {
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


        /*
        Alle Datensätze erkennen
        */
        const blocks =
            splitCompanyBlocks(text);


        /*
        Datenbank EINMAL laden
        */
        const existingCompanies =
            await getExistingCompanies(
                user.id
            );


        let imported = 0;
        let duplicates = 0;
        let invalid = 0;


        /*
        Jeden Datensatz einzeln verarbeiten
        */
        for (
            const block of blocks
        ) {
            const company =
                parseCompany(block);


            if (
                !company?.name
            ) {
                invalid++;
                continue;
            }


            /*
            Bereits vorhandenes
            Unternehmen prüfen.
            */
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


            /*
            Speichern
            */
            const saved =
                await insertCompany(
                    user.id,
                    company
                );


            /*
            Neu gespeichertes Unternehmen
            sofort in den Vergleich aufnehmen.

            Dadurch werden auch doppelte
            Einträge innerhalb desselben
            Imports erkannt.
            */
            if (saved) {
                existingCompanies.push(
                    saved
                );

                imported++;
            }
        }


        return res.status(200).json({
            success:
                true,

            imported:
                imported,

            duplicates:
                duplicates,

            invalid:
                invalid,

            total_blocks:
                blocks.length,

            saved:
                imported
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