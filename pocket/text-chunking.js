const LANGUAGE_LOCALES = {
    "english_2026-04": "en",
    french_24l: "fr",
    german: "de",
    italian: "it",
    portuguese: "pt",
    spanish: "es",
};

const SENTENCE_END = /[.!?…]["'’”»\)\]\}]*$/u;
const CLAUSE_END = /[,;:–—]["'’”»\)\]\}]*$/u;

/**
 * Split the prepared prompt using source-text boundaries, never token slices.
 * Token counts only decide which complete words fit in a generation request.
 * A continuation boundary must not receive an extra sentence pause.
 */
export function splitTextIntoChunks(text, { tokenizer, maxTokens, language = "en" }) {
    if (!Number.isInteger(maxTokens) || maxTokens < 1) {
        throw new Error("The speech chunk token limit must be a positive integer.");
    }

    const prompt = text.trim();
    if (!prompt) return [];

    const segmenter = new Intl.Segmenter(LANGUAGE_LOCALES[language] || language, {
        granularity: "sentence",
    });
    const fits = (value) => tokenizer.encodeIds(value).length <= maxTokens;
    const chunks = [];
    let pendingStart = null;
    let pendingEnd = 0;

    const append = (start, end, boundary) => {
        chunks.push({ text: prompt.slice(start, end).trim(), boundary });
    };
    const flush = () => {
        if (pendingStart === null) return;
        const value = prompt.slice(pendingStart, pendingEnd).trim();
        append(pendingStart, pendingEnd, SENTENCE_END.test(value) ? "sentence" : "continuation");
        pendingStart = null;
    };

    for (const { segment, index } of segmenter.segment(prompt)) {
        const sentence = segment.trim();
        if (!sentence) continue;
        const start = index + segment.indexOf(sentence);
        const end = start + sentence.length;

        if (fits(sentence)) {
            if (pendingStart !== null && !fits(prompt.slice(pendingStart, end))) flush();
            if (pendingStart === null) pendingStart = start;
            pendingEnd = end;
            continue;
        }

        flush();
        let remaining = sentence;
        while (!fits(remaining)) {
            let wordEnd = 0;
            let clauseEnd = 0;
            for (const match of remaining.matchAll(/\s+/gu)) {
                const prefix = remaining.slice(0, match.index);
                if (!fits(prefix)) break;
                wordEnd = match.index;
                if (CLAUSE_END.test(prefix)) clauseEnd = wordEnd;
            }

            const cut = clauseEnd || wordEnd;
            if (!cut) {
                // A single unbroken word/URL cannot satisfy both constraints.
                // Fail explicitly instead of silently synthesizing word fragments.
                throw new Error("A word or unbroken text is too long to read. Shorten it or add spaces.");
            }
            chunks.push({ text: remaining.slice(0, cut), boundary: "continuation" });
            remaining = remaining.slice(cut).trimStart();
        }
        chunks.push({
            text: remaining,
            boundary: SENTENCE_END.test(remaining) ? "sentence" : "continuation",
        });
    }

    flush();
    return chunks;
}
