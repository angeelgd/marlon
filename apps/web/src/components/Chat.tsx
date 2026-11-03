import type { ChatImage, UiMessage } from "@marlon/shared";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowUp, CalendarClock, Camera, Dumbbell, Image as ImageIcon, Mic, Paperclip, Sun } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { prepareImage, type CropRect } from "../lib/image";
import { PhotoCrop } from "./PhotoCrop";
import { VoiceButton } from "./VoiceButton";

interface Props {
  messages: UiMessage[];
  sending: boolean;
  /** Modo solo texto: sin micrófono. */
  textOnly: boolean;
  onSend(text: string, images: ChatImage[]): Promise<void>;
  onVoice(wavBase64: string): Promise<void>;
}

interface Pending {
  file: File;
  url: string;
  crop?: CropRect;
}

function greeting(): string {
  const h = new Date().getHours();
  return h < 6 ? "Buenas noches" : h < 14 ? "Buenos días" : h < 21 ? "Buenas tardes" : "Buenas noches";
}

export function Chat({ messages, sending, textOnly, onSend, onVoice }: Props) {
  const [text, setText] = useState("");
  const [photo, setPhoto] = useState<Pending | null>(null);
  const [cropping, setCropping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, sending]);

  useEffect(() => () => {
    if (photo) URL.revokeObjectURL(photo.url);
  }, [photo]);

  const last = messages[messages.length - 1];
  const quickReplies = !sending && last?.role === "assistant" ? (last.quickReplies ?? []) : [];

  async function send(value: string) {
    const t = value.trim();
    if ((!t && !photo) || sending) return;
    setError(null);
    try {
      const images = photo ? [await prepareImage(photo.file, photo.crop)] : [];
      setText("");
      setPhoto(null);
      await onSend(t, images);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function autosize(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }

  return (
    <section className="chat" aria-label="Chat con Marlon">
      <div className="chat-list" ref={listRef}>
        {messages.length === 0 && (
          <div className="chat-empty">
            <h3>{greeting()}, Ángel</h3>
            <p>Dime qué quieres organizar o mándame la foto de tu horario.</p>
            <div className="suggestions">
              <button className="suggestion" onClick={() => fileRef.current?.click()}>
                <Camera size={18} strokeWidth={1.75} /> Leer la foto de mi horario
              </button>
              <button className="suggestion" onClick={() => send("¿Qué tengo hoy?")}>
                <Sun size={18} strokeWidth={1.75} /> ¿Qué tengo hoy?
              </button>
              <button className="suggestion" onClick={() => send("Planifica el gimnasio de esta semana")}>
                <Dumbbell size={18} strokeWidth={1.75} /> Planificar el gimnasio de la semana
              </button>
              <button className="suggestion" onClick={() => send("¿Cuándo tengo un hueco libre mañana?")}>
                <CalendarClock size={18} strokeWidth={1.75} /> Buscar un hueco libre mañana
              </button>
            </div>
          </div>
        )}
        <AnimatePresence initial={false}>
          {messages.map((m) => (
            <motion.div
              key={m.id}
              className={`bubble ${m.role}`}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.18 }}
            >
              {m.hasImages && (
                <span className="bubble-attach">
                  <ImageIcon size={14} strokeWidth={1.75} /> Foto adjunta
                </span>
              )}
              {m.fromVoice && (
                <span className="bubble-attach">
                  <Mic size={14} strokeWidth={1.75} /> Nota de voz
                </span>
              )}
              {m.text && <p>{m.text}</p>}
            </motion.div>
          ))}
        </AnimatePresence>
        {sending && (
          <div className="bubble assistant typing" aria-label="Marlon está escribiendo">
            <span />
            <span />
            <span />
          </div>
        )}
      </div>

      {quickReplies.length > 0 && (
        <div className="quick-replies">
          {quickReplies.map((q) => (
            <button key={q} className="chip" onClick={() => send(q)}>
              {q}
            </button>
          ))}
        </div>
      )}

      {error && <div className="chat-error">{error}</div>}

      {photo && (
        <div className="attach-preview">
          <img src={photo.url} alt="Foto adjunta" />
          <div>
            <span>{photo.crop ? "Recortada" : "Foto completa"}</span>
            <button className="link" onClick={() => setCropping(true)}>
              Recortar
            </button>
            <button className="link" onClick={() => setPhoto(null)}>
              Quitar
            </button>
          </div>
        </div>
      )}

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send(text);
        }}
      >
        <div className="composer-box">
        <button type="button" className="icon-btn quiet" onClick={() => fileRef.current?.click()} aria-label="Adjuntar foto">
          <Paperclip size={20} strokeWidth={1.75} />
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) setPhoto({ file: f, url: URL.createObjectURL(f) });
          }}
        />
        <textarea
          ref={inputRef}
          rows={1}
          value={text}
          placeholder={photo ? "Este es mi horario…" : "Escribe a Marlon"}
          onChange={(e) => {
            setText(e.target.value);
            autosize(e.target);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !("ontouchstart" in window)) {
              e.preventDefault();
              void send(text);
            }
          }}
        />
        {!textOnly && !text.trim() && !photo ? (
          <VoiceButton
            disabled={sending}
            onAudio={(b64) => {
              setError(null);
              void onVoice(b64);
            }}
            onError={setError}
          />
        ) : (
          <button type="submit" className="send-btn" disabled={sending || (!text.trim() && !photo)} aria-label="Enviar">
            <ArrowUp size={19} strokeWidth={2.25} />
          </button>
        )}
        </div>
      </form>

      {cropping && photo && (
        <PhotoCrop
          src={photo.url}
          initial={photo.crop}
          onCancel={() => setCropping(false)}
          onDone={(crop) => {
            setPhoto({ ...photo, crop });
            setCropping(false);
          }}
        />
      )}
    </section>
  );
}
