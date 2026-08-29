export const FUNI_COMMAND_MENU=[
 {command:'start',description:'Start an LP preview or view commands'},
 {command:'help',description:'Explain commands and safety behavior'},
 {command:'positions',description:'List active tracked LP positions'},
 {command:'portfolio',description:'Show the read-only portfolio summary'},
 {command:'bid_ladder_preview',description:'Preview a V4 BID ladder dry run'},
 {command:'bid_ladder_view',description:'View a V4 BID ladder by ID'},
 {command:'bid_ladder_list',description:'List V4 BID ladders'},
 {command:'cancel',description:'Cancel your active LP flow'},
 {command:'chatid',description:'Show this authorized chat ID'},
] as const;

export const START_TEXT='FUNI · manual LP tool\n\nRobinhood Chain is the default. Use /chains to inspect supported chain capabilities. Paste a token contract address to begin a user-authorized manual LP preview.\n\nCommands: /chains, /positions, /portfolio, /bid_ladder_preview, /bid_ladder_view, /bid_ladder_list, /help, /cancel, /chatid.';
export const HELP_TEXT=[
 '/start — explain the bot and begin from a token address.',
 '/chains — select a chain for capability and read-only availability; disabled chains never show execution actions.',
 '/positions — active tracked v3/v4 positions with read-only valuation and management buttons.',
 '/portfolio — aggregate principal, fees, proceeds, PnL, gas, range, and pricing coverage.',
 '/bid_ladder_preview <amount> — explicit dry-run tool for five fixed V4 BID-only slices from the selected V4 pool; an explicit button is required to persist.',
 '/bid_ladder_view <ladder_id> and /bid_ladder_list — inspect persisted V4 BID ladders; fees are not modeled in Phase 1.',
 '/cancel — cancel only your active interaction; never transacts.',
 '/chatid — show the authorized current chat ID.',
 '',
 'Pasting a token address starts the manual pool-selection flow. Portfolio reads never transact. Every execution path is fail-closed. V4 BID Ladder Reposition requires an explicit preview and final confirmation. Unknown accounting is shown as Unavailable.',
].join('\n');
