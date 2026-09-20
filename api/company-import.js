// api/company-import.js

const SUPABASE_URL = process.env.SUPABASE_URL;

const SUPABASE_SERVICE_ROLE_KEY =
    process.env.SUPABASE_SERVICE_ROLE_KEY;

const SUPABASE_ANON_KEY =
    process.env.SUPABASE_ANON_KEY;


/* ==================================================
   SUPABASE
================================================== */

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


/* ==================================================
   HILFSFUNKTIONEN
================================================== */

function clean(value) {

    const text =
        String(value ?? "").trim();

    if (!text) {
        return null;
    }

    const lower =
        text.toLowerCase();

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


/* ==================================================
   FELDER
================================================== */

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


/* ==================================================
   FELDZEILE ERKENNEN
================================================== */

function fieldMatch(line) {

    const match =
        String(line || "").match(
            /^([^:]+):\s*(.*)$/
        );

    if (!match) {
        return null;
    }

    return {
        rawKey:
            match[1].trim(),

        key:
            normalizeKey(match[1]),

        value:
            match[2].trim()
    };
}


function isFieldLine(line) {

    const field =
        fieldMatch(line);

    if (!field) {
        return false;
    }

    return FIELD_NAMES.has(
        field.key
    );
}


/* ==================================================
   FIRMENNAME
================================================== */

function isCompanyNumberLine(line) {

    return /^\[\d+\]\s+/.test(
        String(line || "")
    );
}


function removeCompanyNumber(line) {

    return String(line || "")
        .replace(
            /^\[\d+\]\s*/,
            ""
        )
        .trim();
}


function isCompanyNameLabel(line) {

    const field =
        fieldMatch(line);

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

        const line =
            removeCompanyNumber(
                originalLine
            );

        if (!line) {
            continue;
        }

        if (
            isFieldLine(line)
        ) {
            continue;
        }

        if (
            isCompanyNumberLine(
                originalLine
            )
        ) {
            return line;
        }

        if (
            line.length > 1
        ) {
            return line;
        }
    }

    return null;
}


/* ==================================================
   DATENSÄTZE TRENNEN
==================================================

Unterstützt exakt:

[1] Firma A
Branche: ...
...
Quelle (URL): ...

[2] Firma B
Branche: ...
...

Auch ohne Leerzeilen.
================================================== */

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

        if (!line) {
            continue;
        }


        /*
        [1], [2], [3] usw.
        beginnen immer einen neuen Datensatz.
        */

        if (
            isCompanyNumberLine(line)
        ) {

            if (current.length) {
                flush();
            }

            current.push(line);

            continue;
        }


        /*
        Name:/Firma:/Unternehmen:
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


        current.push(line);
    }


    flush();


    /*
    Fallback für Daten ohne [1], [2] usw.
    */

    if (
        blocks.length === 1
    ) {

        const original =
            blocks[0];

        const rebuilt = [];

        let currentBlock = [];

        for (const line of original) {

            const cleanLine =
                removeCompanyNumber(
                    line
                );

            const startsCompany =
                currentBlock.length > 0 &&
                !isFieldLine(
                    cleanLine
                ) &&
                isFieldLine(
                    currentBlock[
                        currentBlock.length - 1
                    ]
                );

            if (startsCompany) {

                rebuilt.push(
                    currentBlock
                );

                currentBlock = [];
            }

            currentBlock.push(line);
        }

        if (
            currentBlock.length
        ) {
            rebuilt.push(
                currentBlock
            );
        }

        if (
            rebuilt.length > 1
        ) {
            return rebuilt;
        }
    }


    return blocks;
}


/* ==================================================
   FELD AUS BLOCK HOLEN
================================================== */

function getField(
    lines,
    names
) {

    const wanted =
        new Set(
            names.map(
                normalizeKey
            )
        );

    for (
        const line of lines
    ) {

        const field =
            fieldMatch(
                removeCompanyNumber(
                    line
                )
            );

        if (
            field &&
            wanted.has(
                field.key
            )
        ) {
            return field.value;
        }
    }

    return null;
}


/* ==================================================
   TELEFON
==================================================

Unterstützt:

Telefon (Zentrale/Geschäftsleitung):
+49 2622 2442 (ungeprüft)

Telefon:
0261 123456

Tel.:
0261 123456

Mobil:
0176 12345678
================================================== */

function getPhone(lines) {

    for (
        const line of lines
    ) {

        const cleanLine =
            removeCompanyNumber(
                line
            );

        const match =
            cleanLine.match(
                /^telefon(?:\s*\([^)]*\))?\s*:\s*(.+)$/i
            );

        if (match) {

            return clean(
                match[1]
            );
        }
    }


    for (
        const line of lines
    ) {

        const cleanLine =
            removeCompanyNumber(
                line
            );

        const match =
            cleanLine.match(
                /^(?:tel\.?|phone|fon|mobil|mobile)(?:\s*\([^)]*\))?\s*:\s*(.+)$/i
            );

        if (match) {

            return clean(
                match[1]
            );
        }
    }

    return null;
}


/* ==================================================
   ANSPRECHPARTNER
==================================================

Beispiel:

Ansprechpartner (Name, Funktion):
Hans-Peter Schiffer (Inhaber)

wird:

contact_name = Hans-Peter Schiffer
contact_role = Inhaber
================================================== */

function getContact(lines) {

    let value =
        null;

    for (
        const line of lines
    ) {

        const cleanLine =
            removeCompanyNumber(
                line
            );

        const match =
            cleanLine.match(
                /^ansprechpartner(?:\s*\([^)]*\))?\s*:\s*(.+)$/i
            );

        if (match) {

            value =
                clean(
                    match[1]
                );

            break;
        }
    }


    if (!value) {

        for (
            const line of lines
        ) {

            const cleanLine =
                removeCompanyNumber(
                    line
                );

            const match =
                cleanLine.match(
                    /^(?:kontakt|kontaktperson)\s*:\s*(.+)$/i
                );

            if (match) {

                value =
                    clean(
                        match[1]
                    );

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


    /*
    Letzte Klammer gilt als Funktion.

    Beispiel:
    Thomas Preißing (Inhaber)

    */

    const roleMatch =
        value.match(
            /^(.+?)\s*\(([^()]*)\)\s*$/
        );


    if (roleMatch) {

        return {
            name:
                clean(
                    roleMatch[1]
                ),

            role:
                clean(
                    roleMatch[2]
                )
        };
    }


    /*
    Falls kein Rollenwert
    vorhanden ist.
    */

    return {
        name:
            clean(value),

        role:
            null
    };
}


/* ==================================================
   MITARBEITER
================================================== */

function parseEmployees(
    value
) {

    const raw =
        clean(value);

    if (!raw) {
        return null;
    }


    /*
    Einzelwert:

    15
    ca. 15
    */

    const single =
        raw.match(
            /\b(\d+)\b/
        );

    if (!single) {
        return null;
    }


    const first =
        Number(
            single[1]
        );

    if (
        !Number.isFinite(first)
    ) {
        return null;
    }


    /*
    Bereich:

    10–25
    10-25
    10 bis 25

    Wir speichern den Mittelwert,
    damit die bestehende employees-Spalte
    weiterhin numerisch nutzbar bleibt.
    */

    const range =
        raw.match(
            /(\d+)\s*(?:-|–|—|bis)\s*(\d+)/
        );

    if (range) {

        const min =
            Number(
                range[1]
            );

        const max =
            Number(
                range[2]
            );

        if (
            Number.isFinite(min) &&
            Number.isFinite(max)
        ) {

            return Math.round(
                (min + max) / 2
            );
        }
    }


    return first;
}


/* ==================================================
   RECHTSFORM
================================================== */

function detectLegalForm(
    text
) {

    const value =
        String(text || "")
            .toLowerCase();


    if (
        value.includes(
            "gmbh & co"
        )
    ) {
        return "GmbH & Co. KG";
    }

    if (
        value.includes(
            "einzelunternehmen"
        )
    ) {
        return "Einzelunternehmen";
    }

    if (
        /\be\.?\s*k\.?\b/.test(
            value
        )
    ) {
        return "e.K.";
    }

    if (
        /\bgmbh\b/.test(
            value
        )
    ) {
        return "GmbH";
    }

    if (
        /\bug\b/.test(
            value
        )
    ) {
        return "UG";
    }

    if (
        /\bag\b/.test(
            value
        )
    ) {
        return "AG";
    }

    if (
        /\bohg\b/.test(
            value
        )
    ) {
        return "OHG";
    }

    if (
        /\bkg\b/.test(
            value
        )
    ) {
        return "KG";
    }

    if (
        /\bgbr\b/.test(
            value
        )
    ) {
        return "GbR";
    }

    return null;
}


/* ==================================================
   ENERGIEBEDARF
==================================================

Eingabe:

hoch (Backöfen, Kühlung)

wird:

energy_demand = hoch
energy_reason = Backöfen, Kühlung
================================================== */

function getEnergy(
    lines
) {

    let value =
        getField(
            lines,
            [
                "energiebedarf",
                "energiebedarfe",
                "energie"
            ]
        );


    if (!value) {

        return {
            demand: null,
            reason: null
        };
    }


    value =
        String(value)
            .trim();


    const match =
        value.match(
            /^(hoch|mittel|niedrig)\s*(?:\((.*)\))?$/i
        );


    if (match) {

        return {
            demand:
                clean(
                    match[1]
                )?.toLowerCase(),

            reason:
                clean(
                    match[2]
                )
        };
    }


    /*
    Falls die Begründung
    anders formatiert wurde.
    */

    const lower =
        value.toLowerCase();

    let demand =
        null;


    if (
        lower.startsWith("hoch")
    ) {
        demand = "hoch";
    } else if (
        lower.startsWith("mittel")
    ) {
        demand = "mittel";
    } else if (
        lower.startsWith("niedrig")
    ) {
        demand = "niedrig";
    }


    const reason =
        value
            .replace(
                /^(hoch|mittel|niedrig)\s*/i,
                ""
            )
            .replace(
                /^\(/,
                ""
            )
            .replace(
                /\)$/,
                ""
            )
            .trim();


    return {
        demand:
            clean(demand),

        reason:
            clean(reason)
    };
}


/* ==================================================
   QUELLE
================================================== */

function getSourceUrl(
    lines
) {

    const value =
        getField(
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

    const urlMatch =
        value.match(
            /https?:\/\/[^\s)]+/i
        );

    if (urlMatch) {
        return urlMatch[0];
    }

    return clean(value);
}


/* ==================================================
   UNTERNEHMEN PARSEN
================================================== */

function parseCompany(
    block
) {

    const cleanedLines =
        block.map(
            removeCompanyNumber
        );


    const joined =
        cleanedLines.join(
            " "
        );


    const name =
        getField(
            cleanedLines,
            [
                "name",
                "firma",
                "unternehmen",
                "firmenname"
            ]
        ) ||
        guessCompanyName(
            cleanedLines
        );


    if (!name) {
        return null;
    }


    const employeesRaw =
        getField(
            cleanedLines,
            [
                "mitarbeiter",
                "mitarbeiterzahl",
                "mitarbeiteranzahl",
                "employees"
            ]
        );


    const employees =
        parseEmployees(
            employeesRaw
        );


    const legalForm =
        getField(
            cleanedLines,
            [
                "rechtsform",
                "unternehmensform",
                "firmenform"
            ]
        ) ||
        detectLegalForm(
            joined
        );


    const contact =
        getContact(
            cleanedLines
        );


    const energy =
        getEnergy(
            cleanedLines
        );


    const sourceUrl =
        getSourceUrl(
            cleanedLines
        );


    return {

        name:
            clean(name),

        legal_name:
            clean(name),

        address:
            clean(
                getField(
                    cleanedLines,
                    [
                        "adresse",
                        "anschrift"
                    ]
                )
            ),

        postal_code:
            clean(
                getField(
                    cleanedLines,
                    [
                        "plz",
                        "postleitzahl"
                    ]
                )
            ),

        city:
            clean(
                getField(
                    cleanedLines,
                    [
                        "ort",
                        "stadt"
                    ]
                )
            ),

        phone:
            getPhone(
                cleanedLines
            ),

        contact_name:
            contact.name,

        contact_role:
            contact.role,

        website:
            clean(
                getField(
                    cleanedLines,
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
                    cleanedLines,
                    [
                        "branche",
                        "branchen",
                        "industrie",
                        "kategorie"
                    ]
                )
            ),

        employees:
            employees,

        legal_form:
            clean(
                legalForm
            ),

        energy_demand:
            energy.demand,

        energy_reason:
            energy.reason,

        source_url:
            sourceUrl,

        description:
            clean(
                getField(
                    cleanedLines,
                    [
                        "beschreibung",
                        "description",
                        "info"
                    ]
                )
            )
    };
}


/* ==================================================
   DUPLIKAT-VERGLEICH
================================================== */

function normalizeText(
    value
) {

    return String(value || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(
            /[\u0300-\u036f]/g,
            ""
        )
        .replace(
            /ä/g,
            "ae"
        )
        .replace(
            /ö/g,
            "oe"
        )
        .replace(
            /ü/g,
            "ue"
        )
        .replace(
            /ß/g,
            "ss"
        )
        .replace(
            /[^a-z0-9]/g,
            ""
        );
}


function normalizePhone(
    value
) {

    return String(value || "")
        .replace(
            /\D/g,
            ""
        );
}


function normalizeWebsite(
    value
) {

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


function sameCompany(
    a,
    b
) {

    const nameA =
        normalizeText(
            a.name
        );

    const nameB =
        normalizeText(
            b.name
        );


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
        normalizeText(
            a.city
        );

    const cityB =
        normalizeText(
            b.city
        );


    const addressA =
        normalizeText(
            a.address
        );

    const addressB =
        normalizeText(
            b.address
        );


    const phoneA =
        normalizePhone(
            a.phone
        );

    const phoneB =
        normalizePhone(
            b.phone
        );


    const websiteA =
        normalizeWebsite(
            a.website
        );

    const websiteB =
        normalizeWebsite(
            b.website
        );


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


/* ==================================================
   BESTEHENDE UNTERNEHMEN LADEN
================================================== */

async function getExistingCompanies(
    userId
) {

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


/* ==================================================
   UNTERNEHMEN SPEICHERN
================================================== */

async function insertCompany(
    userId,
    company
) {

    const response =
        await fetch(
            `${SUPABASE_URL}/rest/v1/companies`,
            {
                method:
                    "POST",

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


/* ==================================================
   API
================================================== */

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
            await getUser(
                req
            );


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
        Alle Unternehmensblöcke
        erkennen.
        */

        const blocks =
            splitCompanyBlocks(
                text
            );


        if (!blocks.length) {

            return res.status(400).json({
                error:
                    "Keine Unternehmensdatensätze erkannt."
            });
        }


        /*
        Bestehende Unternehmen
        nur EINMAL laden.
        */

        const existingCompanies =
            await getExistingCompanies(
                user.id
            );


        let imported =
            0;

        let duplicates =
            0;

        let invalid =
            0;

        const errors =
            [];


        /*
        Jeden Datensatz einzeln
        verarbeiten.
        */

        for (
            let index = 0;
            index < blocks.length;
            index++
        ) {

            const block =
                blocks[index];


            try {

                const company =
                    parseCompany(
                        block
                    );


                if (
                    !company?.name
                ) {

                    invalid++;

                    errors.push({
                        index:
                            index + 1,

                        error:
                            "Firmenname konnte nicht erkannt werden."
                    });

                    continue;
                }


                /*
                Duplikat prüfen.
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
                Unternehmen speichern.
                */

                const saved =
                    await insertCompany(
                        user.id,
                        company
                    );


                if (saved) {

                    existingCompanies.push(
                        saved
                    );

                    imported++;
                }

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
                imported,

            errors:
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