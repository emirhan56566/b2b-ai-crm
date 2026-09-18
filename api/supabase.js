// api/supabase.js

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl) {
  throw new Error("SUPABASE_URL fehlt.");
}

if (!serviceRoleKey) {
  throw new Error("SUPABASE_SERVICE_ROLE_KEY fehlt.");
}

function buildUrl(table, params = {}) {
  const url = new URL(`${supabaseUrl}/rest/v1/${table}`);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }

  return url;
}

function createQuery(table) {
  const state = {
    select: "*",
    filters: [],
    order: null,
    limit: null,
    method: "GET",
    body: null,
    single: false
  };

  const query = {
    select(columns = "*") {
      state.select = columns;
      return query;
    },

    eq(column, value) {
      state.filters.push(`${column}=eq.${encodeURIComponent(value)}`);
      return query;
    },

    order(column, options = {}) {
      state.order =
        `${column}.${options.ascending === false ? "desc" : "asc"}`;
      return query;
    },

    limit(value) {
      state.limit = value;
      return query;
    },

    insert(data) {
      state.method = "POST";
      state.body = data;
      return query;
    },

    update(data) {
      state.method = "PATCH";
      state.body = data;
      return query;
    },

    delete() {
      state.method = "DELETE";
      return query;
    },

    single() {
      state.single = true;
      return query;
    },

    then(resolve, reject) {
      execute().then(resolve, reject);
    }
  };

  async function execute() {
    const params = {
      select: state.select
    };

    if (state.filters.length) {
      for (const filter of state.filters) {
        const [column, ...rest] = filter.split("=");
        params[column] = rest.join("=");
      }
    }

    if (state.order) {
      params.order = state.order;
    }

    if (state.limit !== null) {
      params.limit = state.limit;
    }

    const url = buildUrl(table, params);

    const headers = {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json"
    };

    if (state.method === "POST") {
      headers.Prefer = "return=representation";
    }

    if (state.method === "PATCH") {
      headers.Prefer = "return=representation";
    }

    const response = await fetch(url, {
      method: state.method,
      headers,
      body:
        state.body !== null
          ? JSON.stringify(state.body)
          : undefined
    });

    const raw = await response.text();

    let data = null;

    if (raw) {
      try {
        data = JSON.parse(raw);
      } catch {
        data = raw;
      }
    }

    if (!response.ok) {
      return {
        data: null,
        error: {
          message:
            data?.message ||
            data?.error_description ||
            data?.hint ||
            raw ||
            `Supabase Fehler ${response.status}`,
          status: response.status
        }
      };
    }

    if (state.single) {
      if (Array.isArray(data)) {
        return {
          data: data[0] || null,
          error: data.length ? null : {
            message: "Kein Datensatz gefunden."
          }
        };
      }
    }

    return {
      data,
      error: null
    };
  }

  return query;
}

export const supabase = {
  from(table) {
    return createQuery(table);
  }
};