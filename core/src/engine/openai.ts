import { OpenAI, toFile } from "openai";
import { assertExists } from "@davidsouther/jiffies/lib/esm/assert.js";
import type { Content } from "../content/content.js";
import type { PipelineSettings } from "../ailly.js";
import type { Message, Summary } from "./index.js";
import { LOGGER, isDefined } from "../util.js";
import { encode } from "../encoding.js";

export const name = "openai";

// const MODEL = "gpt-3.5-turbo-0613";
// const FT_MODEL = process.env["OPENAI_FT_MODEL"];
const MODEL = "gpt-4-0613";
// const MODEL = `ft:${BASE_MODEL}:personal::${FT_MODEL}`;
// const MODEL = "gpt-3.5-turbo-16k-0613";
const EMBEDDING_MODEL = "text-embedding-ada-002";

export async function generate(
  c: Content,
  { model = MODEL }: PipelineSettings
): Promise<{ message: string; debug: unknown }> {
  const apiKey = assertExists(
    process.env["OPENAI_API_KEY"],
    "Missing OPENAI_API_KEY"
  );
  const baseURL = process.env["OPENAI_BASE_URL"];
  const openai = new OpenAI({ apiKey, baseURL });

  let messages = c.meta?.messages ?? [];
  if (messages.length < 2) {
    throw new Error("Not enough messages");
  }
  if (messages.at(-1)?.role == "assistant") {
    messages = messages.slice(0, -1);
  }

  const body = {
    messages: (c.meta?.messages ?? []).map(({ role, content }) => ({
      role,
      content,
    })),
    model,
  };

  try {
    const completions = await callOpenAiWithRateLimit(openai, body);
    if (!completions) {
      throw new Error(
        "Failed to get completions and call with rate limit did not itself error"
      );
    }

    const choice = completions.choices[0];
    LOGGER.debug(`Response from OpenAI for ${c.name}`, {
      id: completions.id,
      finish_reason: choice.finish_reason,
    });
    return {
      message: choice.message.content ?? "",
      debug: {
        id: completions.id,
        model: completions.model,
        usage: completions.usage,
        finish: choice.finish_reason,
      },
    };
  } catch (e) {
    console.warn(`Error from OpenAI for ${c.name}`, e);
    return {
      message: "💩",
      debug: { finish: "Failed", error: { message: (e as Error).message } },
    };
  }
}

async function callOpenAiWithRateLimit(
  openai: OpenAI,
  content: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming
): Promise<OpenAI.Chat.Completions.ChatCompletion | undefined> {
  let retry = 3;
  while (retry > 0) {
    retry -= 1;
    try {
      return openai.chat.completions.create(content);
    } catch (e: any) {
      LOGGER.warn("Error calling openai", e.message);
      if (retry == 0) {
        throw new Error("Failed 3 times to call openai" /*, { cause: e }*/);
      }
      if (e.error.code == "rate_limit_exceeded") {
        await new Promise((resolve) => {
          const wait = Number(e.headers["retry-after-ms"]);
          LOGGER.info(`Waiting ${wait}ms...`);
          setTimeout(resolve, wait);
        });
      }
    }
  }
}

export async function format(
  contents: Content[],
  context: Record<string, Content>
): Promise<Summary> {
  const summary: Summary = { prompts: contents.length, tokens: 0 };
  for (const content of contents) {
    summary.tokens += await addContentMeta(content, context);
  }
  return summary;
}

async function addContentMeta(
  content: Content,
  context: Record<string, Content>
) {
  content.meta ??= {};
  content.meta.messages = getMessages(content, context);
  let tokens = 0;
  for (const message of content.meta.messages) {
    const toks = (await encode(message.content)).length;
    message.tokens = toks;
    tokens += toks;
  }
  return tokens;
}

export function getMessages(
  content: Content,
  context: Record<string, Content>
): Message[] {
  const system: string = (content.context.system ?? [])
    .map((s) => s.content)
    .join("\n");
  const history: Content[] = [];
  while (content) {
    history.push(content);
    content = context[content.context.predecessor!];
  }
  history.reverse();
  const augment = history
    .map<Array<Message | undefined>>(
      (c) =>
        (c.context.augment ?? []).map<Message>(({ content }) => ({
          role: "user",
          content: "Background information: " + content,
        })) ?? []
    )
    .flat()
    .filter(isDefined)
    .slice(0, 1);
  const parts = history
    .map<Array<Message | undefined>>((content) => [
      {
        role: "user",
        content: content.prompt,
      },
      content.response
        ? { role: "assistant", content: content.response }
        : undefined,
    ])
    .flat()
    .filter(isDefined);
  return [{ role: "system", content: system }, ...augment, ...parts];
}

export async function tune(
  content: Content[],
  context: Record<string, Content>,
  {
    model = MODEL,
    apiKey = process.env["OPENAI_API_KEY"] ?? "",
    baseURL,
  }: { model: string; apiKey: string; baseURL: string }
) {
  const openai = new OpenAI({ apiKey, baseURL });
  await format(content, context); // fill in content parts

  const file = content
    .map((c) =>
      JSON.stringify({
        messages: (c.meta?.messages ?? []).map(({ role, content }) => ({
          role,
          content,
        })),
      })
    )
    .join("\n");
  const trainingFile = await openai.files.create({
    file: await toFile(Buffer.from(file)),
    purpose: "fine-tune",
  });

  LOGGER.info("Created openai training file", trainingFile);

  const fineTune = await openai.fineTuning.jobs.create({
    training_file: trainingFile.id,
    model,
  });

  LOGGER.info("Started fine-tuning job", fineTune);
  LOGGER.info(
    `New fine tuning model should be ft:${fineTune.model}:${fineTune.organization_id}::${fineTune.id}`
  );
}

export async function vector(
  input: string,
  {
    model = EMBEDDING_MODEL,
    apiKey = process.env["OPENAI_API_KEY"] ?? "",
    baseURL,
  }: { model: string; apiKey: string; baseURL?: string }
): Promise<number[]> {
  const openai = new OpenAI({ apiKey, baseURL });

  const embedding = await openai.embeddings.create({ input, model });
  return embedding.data[0].embedding;
}
