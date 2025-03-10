import type { NextApiResponse } from 'next';
import { ChatContextFilter } from '@/service/common/tiktoken';
import type { moduleDispatchResType, ChatItemType } from '@fastgpt/global/core/chat/type.d';
import { ChatRoleEnum } from '@fastgpt/global/core/chat/constants';
import { sseResponseEventEnum } from '@fastgpt/service/common/response/constant';
import { textAdaptGptResponse } from '@/utils/adapt';
import { getAIApi } from '@fastgpt/service/core/ai/config';
import type { ChatCompletion, StreamChatType } from '@fastgpt/global/core/ai/type.d';
import { TaskResponseKeyEnum } from '@fastgpt/global/core/chat/constants';
import { countModelPrice } from '@/service/support/wallet/bill/utils';
import type { ChatModelItemType } from '@fastgpt/global/core/ai/model.d';
import { postTextCensor } from '@/service/common/censor';
import { ChatCompletionRequestMessageRoleEnum } from '@fastgpt/global/core/ai/constant';
import type { ModuleItemType } from '@fastgpt/global/core/module/type.d';
import { countMessagesTokens, sliceMessagesTB } from '@/global/common/tiktoken';
import { adaptChat2GptMessages } from '@/utils/common/adapt/message';
import { Prompt_QuotePromptList, Prompt_QuoteTemplateList } from '@/global/core/prompt/AIChat';
import type { AIChatProps } from '@/types/core/aiChat';
import { replaceVariable } from '@/global/common/string/tools';
import type { ModuleDispatchProps } from '@/types/core/chat/type';
import { responseWrite, responseWriteController } from '@fastgpt/service/common/response';
import { getChatModel, ModelTypeEnum } from '@/service/core/ai/model';
import type { SearchDataResponseItemType } from '@fastgpt/global/core/dataset/type';

export type ChatProps = ModuleDispatchProps<
  AIChatProps & {
    userChatInput: string;
    history?: ChatItemType[];
    quoteQA?: SearchDataResponseItemType[];
    limitPrompt?: string;
  }
>;
export type ChatResponse = {
  [TaskResponseKeyEnum.answerText]: string;
  [TaskResponseKeyEnum.responseData]: moduleDispatchResType;
  [TaskResponseKeyEnum.history]: ChatItemType[];
};

/* request openai chat */
export const dispatchChatCompletion = async (props: ChatProps): Promise<ChatResponse> => {
  let {
    res,
    stream = false,
    detail = false,
    user,
    outputs,
    inputs: {
      model,
      temperature = 0,
      maxToken = 4000,
      history = [],
      quoteQA = [],
      userChatInput,
      isResponseAnswerText = true,
      systemPrompt = '',
      limitPrompt,
      quoteTemplate,
      quotePrompt
    }
  } = props;
  if (!userChatInput) {
    return Promise.reject('Question is empty');
  }

  stream = stream && isResponseAnswerText;

  // temperature adapt
  const modelConstantsData = getChatModel(model);

  if (!modelConstantsData) {
    return Promise.reject('The chat model is undefined, you need to select a chat model.');
  }

  const { filterQuoteQA, quoteText } = filterQuote({
    quoteQA,
    model: modelConstantsData,
    quoteTemplate
  });

  if (modelConstantsData.censor) {
    await postTextCensor({
      text: `${systemPrompt}
      ${quoteText}
      ${userChatInput}
      `
    });
  }

  const { messages, filterMessages } = getChatMessages({
    model: modelConstantsData,
    history,
    quoteText,
    quotePrompt,
    userChatInput,
    systemPrompt,
    limitPrompt
  });
  const { max_tokens } = getMaxTokens({
    model: modelConstantsData,
    maxToken,
    filterMessages
  });

  // FastGPT temperature range: 1~10
  temperature = +(modelConstantsData.maxTemperature * (temperature / 10)).toFixed(2);
  temperature = Math.max(temperature, 0.01);
  const ai = getAIApi(user.openaiAccount, 480000);

  const response = await ai.chat.completions.create(
    {
      model,
      temperature,
      max_tokens,
      stream,
      messages: [
        ...(modelConstantsData.defaultSystemChatPrompt
          ? [
              {
                role: ChatCompletionRequestMessageRoleEnum.System,
                content: modelConstantsData.defaultSystemChatPrompt
              }
            ]
          : []),
        ...messages
      ]
    },
    {
      headers: {
        Accept: 'application/json, text/plain, */*'
      }
    }
  );

  const { answerText, totalTokens, completeMessages } = await (async () => {
    if (stream) {
      // sse response
      const { answer } = await streamResponse({
        res,
        detail,
        stream: response
      });
      // count tokens
      const completeMessages = filterMessages.concat({
        obj: ChatRoleEnum.AI,
        value: answer
      });

      const totalTokens = countMessagesTokens({
        messages: completeMessages
      });

      targetResponse({ res, detail, outputs });

      return {
        answerText: answer,
        totalTokens,
        completeMessages
      };
    } else {
      const unStreamResponse = response as ChatCompletion;
      const answer = unStreamResponse.choices?.[0]?.message?.content || '';
      const totalTokens = unStreamResponse.usage?.total_tokens || 0;

      const completeMessages = filterMessages.concat({
        obj: ChatRoleEnum.AI,
        value: answer
      });

      return {
        answerText: answer,
        totalTokens,
        completeMessages
      };
    }
  })();

  return {
    [TaskResponseKeyEnum.answerText]: answerText,
    [TaskResponseKeyEnum.responseData]: {
      price: user.openaiAccount?.key
        ? 0
        : countModelPrice({ model, tokens: totalTokens, type: ModelTypeEnum.chat }),
      model: modelConstantsData.name,
      tokens: totalTokens,
      question: userChatInput,
      maxToken: max_tokens,
      quoteList: filterQuoteQA,
      historyPreview: getHistoryPreview(completeMessages)
    },
    [TaskResponseKeyEnum.history]: completeMessages
  };
};

function filterQuote({
  quoteQA = [],
  model,
  quoteTemplate
}: {
  quoteQA: ChatProps['inputs']['quoteQA'];
  model: ChatModelItemType;
  quoteTemplate?: string;
}) {
  function getValue(item: SearchDataResponseItemType, index: number) {
    return replaceVariable(quoteTemplate || Prompt_QuoteTemplateList[0].value, {
      q: item.q,
      a: item.a,
      source: item.sourceName,
      sourceId: String(item.sourceId || 'UnKnow'),
      index: index + 1,
      score: item.score.toFixed(4)
    });
  }
  const sliceResult = sliceMessagesTB({
    maxTokens: model.quoteMaxToken,
    messages: quoteQA.map((item, index) => ({
      obj: ChatRoleEnum.System,
      value: getValue(item, index)
    }))
  });

  // slice filterSearch
  const filterQuoteQA = quoteQA.slice(0, sliceResult.length);

  const quoteText =
    filterQuoteQA.length > 0
      ? `${filterQuoteQA.map((item, index) => getValue(item, index)).join('\n')}`
      : '';

  return {
    filterQuoteQA,
    quoteText
  };
}
function getChatMessages({
  quotePrompt,
  quoteText,
  history = [],
  systemPrompt,
  limitPrompt,
  userChatInput,
  model
}: {
  quotePrompt?: string;
  quoteText: string;
  history: ChatProps['inputs']['history'];
  systemPrompt: string;
  limitPrompt?: string;
  userChatInput: string;
  model: ChatModelItemType;
}) {
  const question = quoteText
    ? replaceVariable(quotePrompt || Prompt_QuotePromptList[0].value, {
        quote: quoteText,
        question: userChatInput
      })
    : userChatInput;

  const messages: ChatItemType[] = [
    ...(systemPrompt
      ? [
          {
            obj: ChatRoleEnum.System,
            value: systemPrompt
          }
        ]
      : []),
    ...history,
    ...(limitPrompt
      ? [
          {
            obj: ChatRoleEnum.System,
            value: limitPrompt
          }
        ]
      : []),
    {
      obj: ChatRoleEnum.Human,
      value: question
    }
  ];

  const filterMessages = ChatContextFilter({
    messages,
    maxTokens: Math.ceil(model.maxContext - 300) // filter token. not response maxToken
  });

  const adaptMessages = adaptChat2GptMessages({ messages: filterMessages, reserveId: false });

  return {
    messages: adaptMessages,
    filterMessages
  };
}
function getMaxTokens({
  maxToken,
  model,
  filterMessages = []
}: {
  maxToken: number;
  model: ChatModelItemType;
  filterMessages: ChatProps['inputs']['history'];
}) {
  const tokensLimit = model.maxContext;

  /* count response max token */
  const promptsToken = countMessagesTokens({
    messages: filterMessages
  });
  maxToken = promptsToken + model.maxResponse > tokensLimit ? tokensLimit - promptsToken : maxToken;

  return {
    max_tokens: maxToken
  };
}

function targetResponse({
  res,
  outputs,
  detail
}: {
  res: NextApiResponse;
  outputs: ModuleItemType['outputs'];
  detail: boolean;
}) {
  const targets =
    outputs.find((output) => output.key === TaskResponseKeyEnum.answerText)?.targets || [];

  if (targets.length === 0) return;
  responseWrite({
    res,
    event: detail ? sseResponseEventEnum.answer : undefined,
    data: textAdaptGptResponse({
      text: '\n'
    })
  });
}

async function streamResponse({
  res,
  detail,
  stream
}: {
  res: NextApiResponse;
  detail: boolean;
  stream: StreamChatType;
}) {
  const write = responseWriteController({
    res,
    readStream: stream
  });
  let answer = '';
  for await (const part of stream) {
    if (res.closed) {
      stream.controller?.abort();
      break;
    }
    const content = part.choices?.[0]?.delta?.content || '';
    answer += content;

    responseWrite({
      write,
      event: detail ? sseResponseEventEnum.answer : undefined,
      data: textAdaptGptResponse({
        text: content
      })
    });
  }

  if (!answer) {
    return Promise.reject('Chat API is error or undefined');
  }

  return { answer };
}

function getHistoryPreview(completeMessages: ChatItemType[]) {
  return completeMessages.map((item, i) => {
    if (item.obj === ChatRoleEnum.System) return item;
    if (i >= completeMessages.length - 2) return item;
    return {
      ...item,
      value: item.value.length > 15 ? `${item.value.slice(0, 15)}...` : item.value
    };
  });
}
