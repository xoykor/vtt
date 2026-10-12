// Sessão sem slots (Roll20/Foundry): peers ilimitados, sem seletor
// de jogador. Quem hospeda = GM inicial; quem entra com código =
// player. peerId = hash auto-gerado + nome auto-declarado.
// Convite = roomCode/secret (`sala#segredo`); kick = remover peer +
// rotar secret (código antigo invalida). Puro, hermético.

export interface SessionPeer {
  peerId: string;
  displayName: string;
  isGM: boolean;
}

/** Usuário local: peer + ficha padrão p/ falar/rolar. */
export interface SessionUser extends SessionPeer {
  /** Ficha ativa (`sheetId|null`); null = nenhuma selecionada. */
  character: string | null;
}

function slugifyName(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  return slug.length > 0 ? slug.slice(0, 24) : "player";
}

function randomHex(bytes = 4): string {
  try {
    const buf = new Uint8Array(bytes);
    crypto.getRandomValues(buf);
    return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return Math.random().toString(16).slice(2, 2 + bytes * 2);
  }
}

/** peerId = hash curto + nome auto-declarado (único, legível). */
export function createPeerId(displayName: string): string {
  return `${slugifyName(displayName)}-${randomHex(4)}`;
}

/** Novo peer: host chama com isGM=true, join com false. */
export function createPeer(displayName: string, isGM: boolean): SessionPeer {
  const clean = displayName.trim().length > 0 ? displayName.trim() : "Jogador";
  return { peerId: createPeerId(clean), displayName: clean, isGM };
}

/** Novo usuário local (peer + sem ficha ativa). */
export function createUser(displayName: string, isGM: boolean): SessionUser {
  const peer = createPeer(displayName, isGM);
  return { ...peer, character: null };
}

/** Segredo da sala (parte do convite; kick = rotar). */
export function createSecret(): string {
  return randomHex(8);
}

/** Novo segredo invalidando o anterior. */
export function rotateSecret(_oldSecret: string): string {
  return createSecret();
}

/** Código de convite `sala#segredo`. */
export function inviteCode(room: string, secret: string): string {
  if (room.length === 0 || secret.length === 0) throw new Error("invite: missing room/secret");
  return `${room}#${secret}`;
}

/** Divide `sala#segredo` (falha fechada em formato inválido). */
export function parseInviteCode(code: string): { room: string; secret: string } {
  const sep = code.indexOf("#");
  if (sep <= 0 || sep === code.length - 1) throw new Error(`invite: malformed code`);
  return { room: code.slice(0, sep), secret: code.slice(sep + 1) };
}

/** Adiciona peer (puro; sem limite). */
export function addPeer(peers: SessionPeer[], peer: SessionPeer): SessionPeer[] {
  if (peers.some((p) => p.peerId === peer.peerId)) return [...peers];
  return [...peers, peer];
}

/** Remove peer (kick). Puro. */
export function removePeer(peers: SessionPeer[], peerId: string): SessionPeer[] {
  return peers.filter((p) => p.peerId !== peerId);
}

/** Troca a ficha ativa do usuário (`sheetId|null`). Pura. */
export function setCharacter(user: SessionUser, sheetId: string | null): SessionUser {
  return { ...user, character: sheetId };
}
