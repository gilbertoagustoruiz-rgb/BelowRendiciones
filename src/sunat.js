import "dotenv/config";

let tokenCache = null;

export function isSunatConfigured() {
  return Boolean(
    process.env.SUNAT_CLIENT_ID &&
    process.env.SUNAT_CLIENT_SECRET &&
    process.env.SUNAT_QUERY_RUC
  );
}

async function getSunatToken() {
  if (!isSunatConfigured()) {
    throw new Error("SUNAT_NO_CONFIGURADO");
  }

  if (tokenCache && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }

  const clientId = process.env.SUNAT_CLIENT_ID.trim();
  const clientSecret = process.env.SUNAT_CLIENT_SECRET.trim();
  const url = "https://api-seguridad.sunat.gob.pe/v1/clientesextranet/" +
    encodeURIComponent(clientId) + "/oauth2/token/";

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: "https://api.sunat.gob.pe/v1/contribuyente/contribuyentes",
    client_id: clientId,
    client_secret: clientSecret,
  });

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    const error = new Error(data.error_description || data.error || "No se pudo obtener token SUNAT.");
    error.sunatPayload = data;
    throw error;
  }

  const expiresIn = Number(data.expires_in || 3600);
  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + Math.max(60, expiresIn - 60) * 1000,
  };
  return tokenCache.token;
}

function formatDateForSunat(value) {
  if (value === null || value === undefined) {
    throw new Error("Fecha de emisión inválida.");
  }

  const raw = String(value).trim();

  let match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) {
    const [, year, month, day] = match;
    return day + "/" + month + "/" + year;
  }

  match = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (match) {
    return raw;
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("Fecha de emisión inválida.");
  }

  return [
    String(date.getUTCDate()).padStart(2, "0"),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    date.getUTCFullYear(),
  ].join("/");
}

export async function validateCpe(expense) {
  const token = await getSunatToken();
  const queryRuc = process.env.SUNAT_QUERY_RUC.trim();
  const url = "https://api.sunat.gob.pe/v1/contribuyente/contribuyentes/" +
    encodeURIComponent(queryRuc) + "/validarcomprobante";

  const payload = {
    numRuc: String(expense.issuer_ruc),
    codComp: String(expense.document_type),
    numeroSerie: String(expense.series).toUpperCase(),
    numero: Number(expense.document_number),
    fechaEmision: formatDateForSunat(expense.issue_date),
    monto: Number(expense.amount),
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(data.message || "SUNAT rechazó la consulta.");
    error.sunatPayload = data;
    throw error;
  }

  return data;
}

export function mapSunatStatus(data) {
  const estado = String(data?.data?.estadoCp ?? "");
  if (estado === "1") return "VALIDADO";
  if (estado === "2") return "ANULADO";
  if (estado === "0") return "NO_EXISTE";
  if (estado === "3") return "AUTORIZADO";
  if (estado === "4") return "NO_AUTORIZADO";
  return data?.success === false ? "ERROR" : "REVISAR";
}
