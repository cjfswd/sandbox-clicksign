/**
 * Cliente mínimo para a API v3 da Clicksign (padrão JSON:API / Envelopes).
 * Docs: https://developers.clicksign.com/docs/primeiros-passos
 *
 * Porta de src/infra/clicksign.ts: única mudança real é o `fetch` do
 * @tauri-apps/plugin-http em vez do fetch global — roda no Rust, não no
 * motor da webview, então não sofre CORS (a Clicksign não envia
 * Access-Control-Allow-Origin; um fetch de browser puro seria bloqueado).
 */
import { fetch } from '@tauri-apps/plugin-http';

export interface ClicksignConfig {
  baseUrl: string;
  accessToken: string;
}

export interface JsonApiResource<A = Record<string, unknown>> {
  id: string;
  type: string;
  attributes: A;
  links?: { self?: string };
  relationships?: Record<string, unknown>;
}

interface JsonApiDocument<T> {
  data: T;
  errors?: Array<{ title?: string; detail?: string; code?: string }>;
}

export interface EnvelopeAttributes {
  name: string;
  status: 'draft' | 'running' | 'canceled' | 'closed';
  locale: string;
  auto_close: boolean;
  deadline_at: string | null;
}

export interface SignerAttributes {
  name: string;
  email: string;
  status?: string;
  communicate_events?: Record<string, string>;
}

export interface EventAttributes {
  name: string;
  data: {
    signers?: Array<{ key: string; url?: string }>;
    [key: string]: unknown;
  };
  created: string;
}

/**
 * Estado do rate limit reportado pela Clicksign nos headers de resposta
 * (docs: https://developers.clicksign.com/docs/limite-de-requisicoes).
 * `resetAtMs` é o X-Rate-Limit-Reset convertido de Unix seconds para ms.
 */
export interface RateLimitInfo {
  limit: number | null;
  remaining: number | null;
  resetAtMs: number | null;
}

/** Lê os três headers de rate limit de uma resposta; qualquer um ausente/inválido vira null. */
function parseRateLimitHeaders(headers: Headers): RateLimitInfo {
  const toInt = (value: string | null): number | null => {
    if (value === null) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  const resetSeconds = toInt(headers.get('x-rate-limit-reset'));
  return {
    limit: toInt(headers.get('x-rate-limit')),
    remaining: toInt(headers.get('x-rate-limit-remaining')),
    resetAtMs: resetSeconds === null ? null : resetSeconds * 1000,
  };
}

export class ClicksignError extends Error {
  readonly status: number;
  readonly body: string;
  /** Presente quando status === 429; timestamp (ms) em que o limite reseta na Clicksign. */
  readonly rateLimitResetAtMs: number | null;

  constructor(status: number, body: string, message: string, rateLimitResetAtMs: number | null = null) {
    super(message);
    this.name = 'ClicksignError';
    this.status = status;
    this.body = body;
    this.rateLimitResetAtMs = rateLimitResetAtMs;
  }
}

export class ClicksignClient {
  private readonly config: ClicksignConfig;
  private lastRateLimitInfo: RateLimitInfo | null = null;

  constructor(config: ClicksignConfig) {
    this.config = config;
  }

  /** Últimos X-Rate-Limit-* vistos em qualquer resposta (sucesso ou erro). */
  getLastRateLimitInfo(): RateLimitInfo | null {
    return this.lastRateLimitInfo;
  }

  /** Faz UMA requisição HTTP à Clicksign; guarda o rate limit visto e lança ClicksignError em qualquer !ok. */
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.config.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: this.config.accessToken,
        Accept: 'application/vnd.api+json',
        'Content-Type': 'application/vnd.api+json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    this.lastRateLimitInfo = parseRateLimitHeaders(response.headers);

    const text = await response.text();
    if (!response.ok) {
      throw new ClicksignError(
        response.status,
        text,
        `Clicksign ${method} ${path} falhou com HTTP ${response.status}: ${text.slice(0, 500)}`,
        response.status === 429 ? this.lastRateLimitInfo.resetAtMs : null,
      );
    }
    return JSON.parse(text) as T;
  }

  /**
   * Cria o envelope (contêiner do lote de assinatura) em estado 'draft'.
   * `deadlineAt`, quando informado, é uma string ISO 8601 completa; quando
   * omitido, a Clicksign aplica o próprio padrão de 30 dias a partir da
   * criação (confirmado empiricamente contra o sandbox real).
   */
  async createEnvelope(
    name: string,
    deadlineAt?: string,
  ): Promise<JsonApiResource<EnvelopeAttributes>> {
    const result = await this.request<JsonApiDocument<JsonApiResource<EnvelopeAttributes>>>(
      'POST',
      '/api/v3/envelopes',
      {
        data: {
          type: 'envelopes',
          attributes: deadlineAt === undefined ? { name } : { name, deadline_at: deadlineAt },
        },
      },
    );
    return result.data;
  }

  /** Anexa o PDF (como data URI base64) ao envelope. */
  async addDocument(
    envelopeId: string,
    filename: string,
    pdfBase64: string,
  ): Promise<JsonApiResource> {
    const result = await this.request<JsonApiDocument<JsonApiResource>>(
      'POST',
      `/api/v3/envelopes/${envelopeId}/documents`,
      {
        data: {
          type: 'documents',
          attributes: {
            filename,
            content_base64: `data:application/pdf;base64,${pdfBase64}`,
          },
        },
      },
    );
    return result.data;
  }

  /** Registra o signatário no envelope, com os canais de notificação (communicate_events) já resolvidos. */
  async addSigner(
    envelopeId: string,
    signer: {
      name: string;
      email?: string;
      phoneNumber?: string;
      communicateEvents?: {
        signature_request: string;
        signature_reminder: string;
        document_signed: string;
      };
    },
  ): Promise<JsonApiResource<SignerAttributes>> {
    const result = await this.request<JsonApiDocument<JsonApiResource<SignerAttributes>>>(
      'POST',
      `/api/v3/envelopes/${envelopeId}/signers`,
      {
        data: {
          type: 'signers',
          attributes: {
            name: signer.name,
            ...(signer.email !== undefined && { email: signer.email }),
            ...(signer.phoneNumber !== undefined && { phone_number: signer.phoneNumber }),
            refusable: false,
            has_documentation: false,
            communicate_events: signer.communicateEvents ?? {
              signature_request: 'none',
              signature_reminder: 'none',
              document_signed: 'email',
            },
          },
        },
      },
    );
    return result.data;
  }

  /** Requisito de qualificação: define o papel do signatário no documento (ex.: "sign" = parte). */
  async addQualificationRequirement(
    envelopeId: string,
    documentId: string,
    signerId: string,
  ): Promise<JsonApiResource> {
    return this.addRequirement(envelopeId, {
      attributes: { action: 'agree', role: 'sign' },
      documentId,
      signerId,
    });
  }

  /**
   * Requisito de autenticação: como o signatário prova a identidade. Token
   * por e-mail/SMS/WhatsApp, ou `handwritten` — assinatura manuscrita como
   * o próprio ponto de prova, sem enviar/exigir código de verificação.
   */
  async addAuthenticationRequirement(
    envelopeId: string,
    documentId: string,
    signerId: string,
    auth: 'email' | 'sms' | 'whatsapp' | 'handwritten' = 'email',
  ): Promise<JsonApiResource> {
    return this.addRequirement(envelopeId, {
      attributes: { action: 'provide_evidence', auth },
      documentId,
      signerId,
    });
  }

  /** POST genérico de requirement — addQualificationRequirement e addAuthenticationRequirement só variam attributes. */
  private async addRequirement(
    envelopeId: string,
    params: {
      attributes: Record<string, string>;
      documentId: string;
      signerId: string;
    },
  ): Promise<JsonApiResource> {
    const result = await this.request<JsonApiDocument<JsonApiResource>>(
      'POST',
      `/api/v3/envelopes/${envelopeId}/requirements`,
      {
        data: {
          type: 'requirements',
          attributes: params.attributes,
          relationships: {
            document: { data: { type: 'documents', id: params.documentId } },
            signer: { data: { type: 'signers', id: params.signerId } },
          },
        },
      },
    );
    return result.data;
  }

  /** Ativa o envelope: muda o status de draft para running. */
  async activateEnvelope(envelopeId: string): Promise<JsonApiResource<EnvelopeAttributes>> {
    const result = await this.request<JsonApiDocument<JsonApiResource<EnvelopeAttributes>>>(
      'PATCH',
      `/api/v3/envelopes/${envelopeId}`,
      {
        data: {
          id: envelopeId,
          type: 'envelopes',
          attributes: { status: 'running' },
        },
      },
    );
    return result.data;
  }

  /** Busca o envelope por id — usada por testConnection só para validar token/rede (ignora um 404). */
  async getEnvelope(envelopeId: string): Promise<JsonApiResource<EnvelopeAttributes>> {
    const result = await this.request<JsonApiDocument<JsonApiResource<EnvelopeAttributes>>>(
      'GET',
      `/api/v3/envelopes/${envelopeId}`,
    );
    return result.data;
  }

  /** Lista os signatários de um envelope (não usado no fluxo atual — utilitário de depuração). */
  async listSigners(envelopeId: string): Promise<Array<JsonApiResource<SignerAttributes>>> {
    const result = await this.request<JsonApiDocument<Array<JsonApiResource<SignerAttributes>>>>(
      'GET',
      `/api/v3/envelopes/${envelopeId}/signers`,
    );
    return result.data;
  }

  /** Eventos do envelope — o evento `add_signer` traz a URL de assinatura do signatário. */
  async getEnvelopeEvents(envelopeId: string): Promise<Array<JsonApiResource<EventAttributes>>> {
    const result = await this.request<JsonApiDocument<Array<JsonApiResource<EventAttributes>>>>(
      'GET',
      `/api/v3/envelopes/${envelopeId}/events`,
    );
    return result.data;
  }

  /** Dispara a notificação de solicitação de assinatura pelo canal configurado no signatário. */
  async notifySigner(
    envelopeId: string,
    signerId: string,
    message?: string,
  ): Promise<JsonApiResource> {
    const result = await this.request<JsonApiDocument<JsonApiResource>>(
      'POST',
      `/api/v3/envelopes/${envelopeId}/signers/${signerId}/notifications`,
      {
        data: {
          type: 'notifications',
          attributes: message === undefined ? {} : { message },
        },
      },
    );
    return result.data;
  }

  /**
   * Link de assinatura para envio manual ao signatário.
   * É o mesmo link que a Clicksign envia nas notificações — o formato é
   * confirmado pelo campo `url` do evento `add_signer` do envelope
   * (GET /api/v3/envelopes/:id/events).
   */
  signUrl(signerId: string): string {
    return `${this.config.baseUrl}/notarial/widget/signatures/${signerId}/redirect`;
  }
}
