# VTT Tauri P2P — Design Spec (2026-10-11)

## Entendimento
- Mesa D&D 5e: mestre + 5 jogadores.
- App nativo, um código para Windows, Linux, Mac, Android APK.
- iOS fora (conta Apple paga quebra grátis).
- P2P direto por IP:porta como Minecraft. Roda em LAN, ZeroTier, Radmin.
- Recursos premium: fog, iluminação, dado 3D, ficha, editor de mapa, tokens.
- Import SRD 5.1 (CC-BY) via Open5e / 5e SRD API. Sem arte oficial WotC.
- Hospedagem e distribuição 100% grátis via GitHub Releases. Sem servidor central.
- Assunções: host = mestre sempre online; 6 peers por mesa; sem voz nativa no v1 (usa Discord).

## Sucesso
- Mestre cria sala e 5 entram por IP:porta ou mDNS em <30s na mesma rede virtual.
- Mapa com fog + luz roda a 60fps em desktop médio e usável em Android médio.
- Ficha abre offline, importa monstro SRD, rolagem validada pelo host.
- Build desktop + APK sai do CI grátis, instala sem certificado pago (com aviso no Win/Mac).

## Arquitetura (aprovada)
- Tauri 2 + frontend TS (Vite) em um código.
- Rust faz socket direto TCP/UDP + descoberta mDNS.
- Topologia estrela, host autoritativo (mestre).
- Sem conta, sem signaling central no v1. Fallback offline: troca manual de código.
- Distribuição: GitHub Releases (Win/Linux/Mac/APK auto-assinado).

## Componentes (aprovados)
- Mapa: Canvas + grid, fog por máscara, luz por raycasting.
- Tokens: sprite, HP, condições, iniciativa.
- Editor: tiles e camadas, só mestre escreve.
- Ficha D&D 5e local, import SRD, export JSON.
- Dado 3D: Three.js + física leve.
- Rede: sala por IP:porta + código, handshake (versão, sala, papel).
- Save local SQLite + export/import JSON.

## Fluxo de dados (aprovado)
- Descoberta mDNS + IP:porta manual.
- Handshake troca versão, sala, papel.
- Host envia snapshot cheio, depois só deltas.
- Assets por hash com cache local.
- Rolagem: cliente pede, host resolve, difunde resultado.
- Estado crítico via TCP ordenado. Cursor e luz via UDP.

## Erros (aprovados)
- Host cai: mesa pausa, reabre e retoma do save.
- Cliente cai: reconecta com mesmo ID, recebe snapshot.
- Versão diferente: rejeita com mensagem.
- Porta fechada: mostra IP, sugere ZeroTier/Radmin.
- Asset com hash errado: baixa de novo.
- Conflito de edição: só mestre escreve, jogador pede.

## Testes (a aprovar junto)
- Unit Rust: rede, névoa, protocolo.
- Unit front: ficha, import SRD, serialização.
- Integração: host + 5 bots locais.
- E2E: LAN real + ZeroTier, desktop + APK.
- Carga: mapa grande com 6 peers.

## Fora do v1
- Voz e vídeo nativos.
- Persistência central e login.
- iOS e lojas pagas.
- Arte oficial WotC.
