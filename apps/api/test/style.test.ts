import { describe, expect, it } from "vitest";
import { cleanDashes, detectLanguage, extractQuickReplies, polish } from "../src/agent/style";

describe("estilo", () => {
  it("cambia guiones largos y guiones de puntuación por comas", () => {
    expect(cleanDashes("Hoy tienes gimnasio — y luego trabajo.")).toBe("Hoy tienes gimnasio, y luego trabajo.");
    expect(cleanDashes("Vale – lo muevo")).toBe("Vale, lo muevo");
    expect(cleanDashes("Perfecto - te lo paso al jueves")).toBe("Perfecto, te lo paso al jueves");
  });

  it("respeta guiones dentro de palabras, horas y viñetas", () => {
    expect(cleanDashes("batch-cooking de 15:45-22:00")).toBe("batch-cooking de 15:45-22:00");
    expect(cleanDashes("- primero\n- segundo")).toBe("- primero\n- segundo");
  });

  it("no deja comas antes de un punto", () => {
    expect(cleanDashes("Listo —.")).toBe("Listo.");
  });

  it("extrae botones rápidos", () => {
    expect(extractQuickReplies("¿Lo paso al jueves?\n[[opciones: Sí, al jueves 18:00 | No]]")).toEqual({
      text: "¿Lo paso al jueves?",
      quickReplies: ["Sí, al jueves 18:00", "No"],
    });
    expect(polish("Hecho — ya está").quickReplies).toEqual([]);
  });

  it("detecta el idioma", () => {
    expect(detectLanguage("buenos días, ¿qué tengo hoy?")).toBe("es");
    expect(detectLanguage("good morning, what do I have today?")).toBe("en");
    expect(detectLanguage("ok")).toBeNull();
  });
});
