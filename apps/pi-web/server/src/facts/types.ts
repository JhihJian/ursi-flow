/**
 * 会话运行事实的契约。
 *
 * 「运行事实」指这次会话**实际上**用了什么模型、看到了哪些 skills、连了哪些 MCP server、
 * 有哪些工具可用。它只能由会话文件或 pi 运行时给出，不能从 pi home 的配置目录反推：
 * 配置是「现在想让它怎样」，事实是「当时实际上怎样」，两者不一致时以事实为准。
 *
 * 纯类型，零依赖：前面的提取域只在内存里拼出这个形状，谁去读文件、谁来展示由调用方决定。
 */

/** 模型的身份：provider 与 modelId，和会话文件里的写法一致。 */
export interface ModelIdentity {
  provider: string
  model: string
}

/** 一次模型切换：切换后用的模型，以及切换发生的时间（epoch 毫秒）。 */
export interface ModelChange extends ModelIdentity {
  at: number
}

/** 一个 skill 的名字与 SKILL.md 的绝对路径。 */
export interface SkillRef {
  name: string
  location: string
}

/** 一次会话的运行事实。可选的 null 表示「会话文件里没有记」，不表示「会话里没有」。 */
export interface SessionFacts {
  /** `file`：从会话 JSONL 重放；`runtime`：由 pi SDK 运行时直接给出。 */
  source: 'file' | 'runtime'

  model: {
    /** 分支上第一个出现的模型；一个模型都没记录时为 null。 */
    initial: ModelIdentity | null
    /** 分支上最后一个生效的模型。 */
    current: ModelIdentity | null
    /** 最后一个生效的思考等级，来自 thinking_level_change 或 assistant 消息。 */
    thinkingLevel: string | null
    /** 分支上的模型切换，按发生顺序。 */
    changes: ModelChange[]
  }

  skills: {
    /** 系统提示词里列出的 skills，即模型当时看到的清单。 */
    listed: SkillRef[] | null
    /** 用户在消息里展开读取过详情的 skills，即 `<skill>` 块。 */
    read: SkillRef[] | null
  }

  mcp: {
    /**
     * 尽力推断出的 MCP server 名：提示词 mcp_servers 分区只列间接暴露的 server，
     * 直接暴露的只能从工具名前缀推断。连接失败或没暴露任何工具的 server 不会出现。
     */
    servers: string[] | null
    /** 推断口径的说明，与 servers 同时为 null 或同时有值。 */
    note: string | null
  }

  tools: {
    /**
     * 模型声明中可见的工具名。
     *
     * 口径写死在这一句：只数 system 消息 toolsAdded 里声明给模型的工具，不数注册但未激活、
     * 也不数只从别的工具里可达的工具（例如 codemode 脚本里调用的 MCP 工具）。
     */
    names: string[] | null
  }

  /** 系统提示词分区名的集合，按声明的先后顺序。 */
  promptSectionKeys: string[] | null

  /** 会话文件是否记录了系统提示词与工具声明。老会话只记消息，这些事实无从得知。 */
  recorded: boolean

  /** recorded 为 false 时的原因。 */
  reason?: 'not_recorded'
}
