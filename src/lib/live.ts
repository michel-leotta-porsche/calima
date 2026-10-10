// Live Photos (#188, Grilling 10.10.): Bewegung und Ton nur in der Mediathek, ins Buch kommt wie immer das Foto mit Look.
// Der Look liegt nur auf dem Standbild; das Video mit Look neu zu rechnen kostet pro Bild Sekunden und Akku.

/** Schalter „Live“ im Sucher, gemerkt je Gerät; Standard aus */
export const LIVE_KEY = "calima:live";
/** einmaliger Hinweis, dass Live ohne Mikrofon-Erlaubnis keinen Ton hat */
export const MIC_HINT_KEY = "calima:live-ohne-ton";

export const readLive = (v: string | null) => v === "1";

/** nimmt diese Aufnahme ein Live Photo auf? Nie auf einem Film: der zeigt seine Bilder erst entwickelt */
export const liveFor = ({ on, supported, film }: { on: boolean; supported: boolean; film: boolean }) => on && supported && !film;

/** Hinweis zeigen: die App meldet ein Live Photo ohne Ton, und der Hinweis kam noch nie */
export const micHint = (r: { audio?: boolean }, shown: boolean) => r.audio === false && !shown;
