export const PRIVATE_COMMAND_MENU=[
 {command:'start',description:'Start an LP preview or view commands'},
 {command:'help',description:'Explain commands and safety behavior'},
 {command:'positions',description:'List active tracked LP positions'},
 {command:'portfolio',description:'Show the read-only portfolio summary'},
 {command:'rebalance',description:'Preview guarded position rebalance modes'},
 {command:'cancel',description:'Cancel your active LP flow'},
 {command:'chatid',description:'Show this authorized chat ID'},
] as const;

export const START_TEXT='Robinhood LP operator\n\nPaste a token contract address to start a manual LP preview.\n\nCommands: /positions, /portfolio, /rebalance, /help, /cancel, /chatid.\nExecution remains protected by the configured safety gates and final confirmation.';
export const HELP_TEXT=[
 '/start — explain the bot and begin from a token address.',
 '/positions — active tracked v3/v4 positions with read-only valuation and management buttons.',
 '/portfolio — aggregate principal, fees, proceeds, PnL, gas, range, and pricing coverage.',
 '/rebalance — preview normal or fee-compounding rebalance for eligible tracked positions; mode and range choices do not execute, and the one final button is the execution confirmation.',
 '/cancel — cancel only your active private flow; never transacts.',
 '/chatid — show the authorized current chat ID.',
 '',
 'Pasting a token address starts the existing manual pool-selection flow. Portfolio reads never transact. A final rebalance action remains fail-closed unless every configured runtime, signer, accounting, liquidity, slippage, approval, and gas gate passes. Unknown accounting is shown as Unavailable.',
].join('\n');
