/**
 * Cliente mínimo para a API v3 da Clicksign (padrão JSON:API / Envelopes).
 * Docs: https://developers.clicksign.com/docs/primeiros-passos
 */

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

export class ClicksignError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string, message: string) {
    super(message);
    this.name = 'ClicksignError';
    this.status = status;
    this.body = body;
  }
}

export class ClicksignClient {
  private readonly config: ClicksignConfig;

  constructor(config: ClicksignConfig) {
    this.config = config;
  }

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

    const text = await response.text();
    if (!response.ok) {
      throw new ClicksignError(
        response.status,
        text,
        `Clicksign ${method} ${path} falhou com HTTP ${response.status}: ${text.slice(0, 500)}`,
      );
    }
    return JSON.parse(text) as T;
  }

  async createEnvelope(name: string): Promise<JsonApiResource<EnvelopeAttributes>> {
    const result = await this.request<JsonApiDocument<JsonApiResource<EnvelopeAttributes>>>(
      'POST',
      '/api/v3/envelopes',
      { data: { type: 'envelopes', attributes: { name } } },
    );
    return result.data;
  }

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

  /** Requisito de autenticação: como o signatário prova a identidade (token por e-mail/SMS/WhatsApp). */
  async addAuthenticationRequirement(
    envelopeId: string,
    documentId: string,
    signerId: string,
    auth: 'email' | 'sms' | 'whatsapp' = 'email',
  ): Promise<JsonApiResource> {
    return this.addRequirement(envelopeId, {
      attributes: { action: 'provide_evidence', auth },
      documentId,
      signerId,
    });
  }

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

  async getEnvelope(envelopeId: string): Promise<JsonApiResource<EnvelopeAttributes>> {
    const result = await this.request<JsonApiDocument<JsonApiResource<EnvelopeAttributes>>>(
      'GET',
      `/api/v3/envelopes/${envelopeId}`,
    );
    return result.data;
  }

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

export function clientFromEnv(): ClicksignClient {
  const baseUrl = process.env.CLICKSIGN_BASE_URL;
  const accessToken = process.env.CLICKSIGN_ACCESS_TOKEN;
  if (!baseUrl || !accessToken) {
    throw new Error('Defina CLICKSIGN_BASE_URL e CLICKSIGN_ACCESS_TOKEN no .env');
  }
  return new ClicksignClient({ baseUrl, accessToken });
}
