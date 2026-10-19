/**
 * @yophon/tau-gateway (P30): the resident gateway core — channels, conversation
 * routing and queues, access and pairing, approvals in chat, channel plugins.
 * The CLI's `tau gateway` builds conversations; channels come as plugins.
 */
export { type AccessEntry, type AccessStore, FileAccessStore, writePrivateFile } from "./access.ts";
export { ChatApprovals } from "./approvals.ts";
export { type BootedGateway, type BootOptions, bootGateway, channelContext, loadPlugins } from "./boot.ts";
export {
	ALLOWED_MODES,
	type GatewayConfig,
	type GatewayPaths,
	gatewayPaths,
	isPermissionMode,
	loadGatewayConfig,
	OWNER_MODES,
	resolveEnvValue,
} from "./config.ts";
export {
	Gateway,
	type GatewayOptions,
	type GatewayStatus,
	keyId,
	mergeInputs,
	newCode,
	SILENT_REPLY,
} from "./gateway.ts";
export { isChannelPlugin, loadChannelPlugin, resolvePlugin } from "./plugins.ts";
export {
	type Goal,
	type NewGoal,
	type NewSchedule,
	SCHEDULE_LIMITS,
	type Schedule,
	type ScheduleResult,
	ScheduleStore,
	sameKey,
} from "./schedule.ts";
export { createScheduleTools, describeGoal, describeSchedule, type ScheduleToolsHost } from "./schedule-tools.ts";
export {
	acquireLock,
	DailyLog,
	describeStatus,
	readStatus,
	STATUS_STALE_MS,
	type StatusFile,
	writeStatus,
} from "./state.ts";
export { chunkText, summarizeArgs, TEXT } from "./text.ts";
export {
	type CronSpec,
	describeCron,
	describeDuration,
	formatLocalTime,
	isoLocal,
	isTimeZone,
	localTimeZone,
	nextCronTime,
	parseCron,
	parseDuration,
	parseLocalTime,
	shortestCronGap,
	wallTime,
} from "./time.ts";
export type {
	Attachment,
	Channel,
	ChannelContext,
	ChannelPlugin,
	ChannelSink,
	ChannelStatus,
	Conversation,
	ConversationHooks,
	ConversationInput,
	ConversationKey,
	ConversationPolicy,
	InboundMessage,
	OutboundReply,
	PeerRole,
	RunResult,
} from "./types.ts";
