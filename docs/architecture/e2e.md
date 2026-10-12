# E2E

## Responsabilidades

Testes protocol-conformance e rejoin: validam que o guest recebe o snapshot do host sem duplicar tokens, que o loopback TCP real entrega snapshot + delta, e que versão stale é rejeitada no fio.

## Arquivos

- `e2e/room.spec.ts` — rejoin hermético (sem sockets): 6 tokens sem dups + golden fixture Rust.
- `e2e/lan.spec.ts` — loopback TCP real: host `net.Server` + guest `net.Socket`, snapshot + delta, versão stale rejeitada.
- `e2e/fixtures/save-golden.json` — golden gerado pelo Rust (`save::export_json`).

## Decisões

- **Dois níveis de E2E**: `room.spec.ts` é hermético (funções puras, sem socket/servidor/browser); `lan.spec.ts` abre sockets OS reais em-processo (host `net.Server` em `127.0.0.1:0`, guest `net.Socket`).
- **Protocol-conformance (não Rust binary interop)**: `lan.spec.ts` valida os codecs TS contra a spec do protocolo wire (framing `u32` BE length-prefixed + JSON), independente da implementação Rust. Interop Rust real é coberto por `tcp_test.rs`.
- **Node mirror do host**: `LoopbackHost` reimplementa o wire protocol em-processo — handshake version-gate, room reply, snapshot, delta burst, end of stream. Rejeição sem reply frame (EOF = rejection signal), espelhando a failure policy do Rust.
- **FrameReader**: reader buffered para length-prefixed frames — TCP pode coalescer frames back-to-back; bytes são buffered e split frame-by-frame. Socket close com frame pending rejeita (EOF).
- **Golden cross-boundary**: `room.spec.ts` alimenta o JSON do Rust (`save-golden.json`) no caminho real do TS (`applyDelta` + `decodeToken`) e valida os mesmos 6 ids sem duplicatas — divergência na fronteira FFI falha aqui e no Rust.
- **Peças de teste**: mesa 1 mestre + 5 jogadores (`dm` + `p1..p5`).

## Comandos

```bash
npx playwright test e2e/room.spec.ts   # hermético (sem sockets)
npx playwright test e2e/lan.spec.ts    # loopback TCP real (sem browser)
```

`lan.spec.ts` precisa de Chromium instalado em CI (`npx playwright install --with-deps chromium`) mas não usa browser — roda puro Node TCP, offline.

## Pendências

- **Interop Rust↔TS real via binário**: E2E com binário `host.rs` real (não Node host) é Fase 3 Task 5.
- **Browser E2E**: `room.spec.ts` é hermético; testes reais de página (UI) na Fase 3.
