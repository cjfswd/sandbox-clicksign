# HealthMais Assinaturas — Desktop

App desktop **nativo Windows** (sem Electron, sem WebView) compilado com
[Perry](https://github.com/PerryTS/perry) — TypeScript → binário Win32 via SWC + LLVM.

Monta lotes de PDFs (1 documento → 1 destinatário), envia para a **batch API**
(repo raiz) e entrega os links de assinatura da Clicksign com botão de copiar.

## Pré-requisitos de build (uma vez por máquina)

1. **LLVM/clang**: `winget install LLVM.LLVM`
2. **MSVC Build Tools** (linker + `mt.exe`): workload "Desktop development with C++"
   — ou o caminho leve `perry setup windows`
3. `npm install` neste diretório (baixa o compilador Perry pré-compilado)

## Build

```bash
# mt.exe precisa estar no PATH (Windows SDK):
export PATH="$PATH:/c/Program Files (x86)/Windows Kits/10/bin/10.0.26100.0/x64"
npm run build   # gera assinaturas.exe (~16 MB, autossuficiente)
```

O `assinaturas.exe` resultante roda em qualquer Windows x64 — sem instalar nada.

## Uso

1. Abra o app, preencha **URL da API** e **API key** e clique em *Salvar e testar*
   (persistidos no Registry do Windows via `preferences`).
2. *Adicionar PDF* (repetir por documento), preencha nome/e-mail/telefone e o
   tipo de envio por item:
   - **Somente link** — a Clicksign não notifica; copie o link e envie você mesmo
   - **E-mail / WhatsApp** — a Clicksign notifica o destinatário
3. *Enviar lote* — o progresso por item atualiza a cada 3 s; itens concluídos
   ganham o botão *Copiar link*; *Copiar todos os links* copia a lista inteira.

## Arquitetura

- [src/api-client.ts](src/api-client.ts) — cliente HTTP puro da batch API
  (tipos espelham `contracts/batch-contract.ts`; sem dependências)
- [src/main.ts](src/main.ts) — UI declarativa `perry/ui` (widgets Win32 nativos)
- A validação de lote é **importada do backend** (`src/domain/validation.ts` do
  repo raiz) — uma única fonte de verdade das regras, possível porque o Perry
  tem paridade Node (Buffer, fs, fetch funcionam no binário nativo)

## Nota sobre reatividade

Linhas do lote redesenham apenas quando itens entram/saem (`ForEach` sobre
`rowCount`); atualizações de status durante o envio usam os handles imperativos
(`textSetString`/`widgetSetHidden`) para não perder o foco dos campos de texto.
