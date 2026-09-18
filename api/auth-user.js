// api/auth-user.js

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
    if (req.method !== "GET") {
      return res.status(405).json({
        success: false,
        error: "Nur GET erlaubt."
      });
    }

    const { user, error } = await authenticate(req);

    if (!user) {
      return res.status(401).json({
        success: false,
        error: error || "Nicht authentifiziert."
      });
    }

    return res.status(200).json({
      success: true,
      user: {
        id: user.id,
        email: user.email || null,
        created_at: user.created_at || null,
        last_sign_in_at: user.last_sign_in_at || null
      }
    });

  } catch (error) {
    console.error("auth-user error:", error);

    return res.status(500).json({
      success: false,
      error:
        error?.message ||
        "Fehler beim Abrufen des Benutzers."
    });
  }
}