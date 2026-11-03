import type { ChatImage, UiMessage } from "@marlon/shared";
import { AnimatePresence, motion } from "framer-motion";
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
            <p>Hola Ángel 👋</p>
            <p>Mándame la foto de tu horario o dime qué quieres organizar.</p>
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
              {m.hasImages && <span className="bubble-attach">📷 Foto adjunta</span>}
              {m.fromVoice && <span className="bubble-attach">🎙 Nota de voz</span>}
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
        <button type="button" className="icon-btn" onClick={() => fileRef.current?.click()} aria-label="Adjuntar foto">
          📷
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
          placeholder={photo ? "Este es mi horario…" : "Escribe a Marlon…"}
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
            ↑
          </button>
        )}
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
