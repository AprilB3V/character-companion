// onEvent receives the other stream events (for /v1/think: thought_step, decided).
export async function readNativeReply(response, onDelta, onEvent = () => {}) {
    if (!String(response.headers.get('content-type')).includes('event-stream')) return await response.json();
    if (!response.body) throw new Error('Empty CL stream');
    const decoder = new TextDecoder();
    let buffer = '';
    let result = null;
    const handleLine = line => {
        if (!line.startsWith('data:')) return;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') return;
        const event = JSON.parse(data);
        if (event.type === 'error') throw new Error('CL stream failed');
        if (event.type === 'delta' && typeof event.text === 'string') onDelta(event.text);
        else if (event.type === 'end') { const { type, ...payload } = event; result = payload; }
        else onEvent(event);
    };
    for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
            handleLine(buffer.slice(0, newline).replace(/\r$/, ''));
            buffer = buffer.slice(newline + 1);
        }
    }
    buffer += decoder.decode();
    if (buffer.trim()) handleLine(buffer.trim());
    if (!result) throw new Error('CL stream ended before completion');
    return result;
}
