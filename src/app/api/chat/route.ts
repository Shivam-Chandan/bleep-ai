import { NextRequest, NextResponse } from 'next/server';
import type { OllamaRequest, OllamaResponse } from '@/lib/types';

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const DEFAULT_MODEL = process.env.OLLAMA_MODEL || 'llama3.2';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { messages, model = DEFAULT_MODEL, stream = true, options } = body as OllamaRequest;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json({ error: 'Messages are required' }, { status: 400 });
    }

    const ollamaRequest: OllamaRequest = {
      model,
      messages: messages.map((msg) => ({
        role: msg.role,
        content: msg.content,
      })),
      stream,
      options: {
        temperature: 0.7,
        top_p: 0.9,
        num_predict: 2048,
        ...options,
      },
    };

    const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(ollamaRequest),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Ollama API error:', response.status, errorText);
      return NextResponse.json(
        { error: `Ollama API error: ${response.status} ${errorText}` },
        { status: response.status }
      );
    }

    if (stream) {
      const encoder = new TextEncoder();
      const readable = new ReadableStream({
        async start(controller) {
          const reader = response.body?.getReader();
          if (!reader) {
            controller.close();
            return;
          }

          const decoder = new TextDecoder();
          let buffer = '';

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop() || '';

              for (const line of lines) {
                if (line.trim()) {
                  try {
                    const data: OllamaResponse = JSON.parse(line);
                    const chunk = JSON.stringify({
                      content: data.message.content,
                      done: data.done,
                    }) + '\n';
                    controller.enqueue(encoder.encode(chunk));
                  } catch (e) {
                    console.error('Failed to parse Ollama stream chunk:', line);
                  }
                }
              }
            }
          } catch (error) {
            console.error('Stream reading error:', error);
          } finally {
            controller.close();
            reader.releaseLock();
          }
        },
      });

      return new NextResponse(readable, {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Transfer-Encoding': 'chunked',
        },
      });
    } else {
      const data = await response.json();
      return NextResponse.json(data);
    }
  } catch (error) {
    console.error('Chat API error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

export async function GET() {
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
    if (!response.ok) {
      return NextResponse.json({ error: 'Failed to fetch models' }, { status: 500 });
    }
    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('Models fetch error:', error);
    return NextResponse.json({ error: 'Failed to connect to Ollama' }, { status: 500 });
  }
}