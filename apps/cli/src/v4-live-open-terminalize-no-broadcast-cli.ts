import 'dotenv/config';
import { productionDatabasePaths,SqliteLedgerRepository,V4LiveOpenNoBroadcastTerminalizationError } from '@funi/ledger';

const terminalizeCommand='v4-live-open-terminalize-no-broadcast',reconcileCommand='v4-live-open-reconcile-terminalized-no-broadcast';
const command=process.argv[2]??terminalizeCommand;
const output=(value:unknown,stream:NodeJS.WriteStream)=>stream.write(JSON.stringify(value,null,2)+'\n');
const blocked=(code:string,safeEvidenceCategory:string,evidence:Record<string,unknown>={})=>{output({status:'BLOCKED',command,code,safeEvidenceCategory,evidence,signerConstructed:false,nonceReserved:false,journalCreated:false,authorizationCreated:false,commitmentCreated:false,executionInvoked:false,signingUsed:false,broadcastUsed:false,chainReads:0,mainnetTransactionsSent:0},process.stderr);process.exitCode=1;};

function parseArguments(){
 const [selected,...args]=process.argv.slice(2);if(selected!==terminalizeCommand&&selected!==reconcileCommand)throw new V4LiveOpenNoBroadcastTerminalizationError('V4_TERMINALIZATION_COMMAND_MISMATCH','CLI_ARGUMENT');
 const values:Record<string,string>={},allowed=new Set(selected===terminalizeCommand?['--intent-id','--confirm','--reason']:['--intent-id','--confirm']);
 for(let index=0;index<args.length;index+=2){const key=args[index],value=args[index+1];if(!key||!allowed.has(key))throw new V4LiveOpenNoBroadcastTerminalizationError('V4_TERMINALIZATION_UNKNOWN_ARGUMENT','CLI_ARGUMENT',{argument:key??null});if(value===undefined||value.startsWith('--'))throw new V4LiveOpenNoBroadcastTerminalizationError(`V4_TERMINALIZATION_${key.slice(2).replaceAll('-','_').toUpperCase()}_REQUIRED`,'CLI_ARGUMENT');if(values[key]!==undefined)throw new V4LiveOpenNoBroadcastTerminalizationError('V4_TERMINALIZATION_DUPLICATE_ARGUMENT','CLI_ARGUMENT',{argument:key});values[key]=value;}
 const intentId=values['--intent-id'];if(!intentId)throw new V4LiveOpenNoBroadcastTerminalizationError('V4_TERMINALIZATION_INTENT_ID_REQUIRED','CLI_ARGUMENT');
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(intentId))throw new V4LiveOpenNoBroadcastTerminalizationError('V4_TERMINALIZATION_INTENT_ID_MALFORMED','CLI_ARGUMENT');
 const confirm=values['--confirm'];if(!confirm)throw new V4LiveOpenNoBroadcastTerminalizationError('V4_TERMINALIZATION_CONFIRMATION_REQUIRED','CLI_ARGUMENT');
 if(confirm!==intentId)throw new V4LiveOpenNoBroadcastTerminalizationError('V4_TERMINALIZATION_CONFIRMATION_MISMATCH','CLI_ARGUMENT');
 const operatorReason=values['--reason']?.trim();if(selected===terminalizeCommand&&!operatorReason)throw new V4LiveOpenNoBroadcastTerminalizationError('V4_TERMINALIZATION_REASON_REQUIRED','CLI_ARGUMENT');
 return {command:selected,intentId,operatorReason};
}

function main(){
 try{
  const input=parseArguments(),databasePath=productionDatabasePaths({dataDir:process.env.DATA_DIR,databasePath:process.env.DATABASE_PATH}).databasePath;
  let writer:SqliteLedgerRepository|undefined,write;
  try{writer=new SqliteLedgerRepository(databasePath);write=input.command===terminalizeCommand?writer.terminalizeV4LiveOpenNoBroadcast({intentId:input.intentId,operatorReason:input.operatorReason!,terminalizedAt:new Date().toISOString()}):writer.reconcileV4LiveOpenTerminalizedNoBroadcast(input.intentId);}finally{writer?.close();}
  let verifier:SqliteLedgerRepository|undefined;
  try{verifier=new SqliteLedgerRepository(databasePath);output(input.command===terminalizeCommand?verifier.verifyV4LiveOpenNoBroadcastTerminalization(write as any):verifier.verifyV4LiveOpenTerminalizedNoBroadcastReconciliation(write as any),process.stdout);}finally{verifier?.close();}
 }catch(error){
  if(error instanceof V4LiveOpenNoBroadcastTerminalizationError)blocked(error.code,error.safeEvidenceCategory,error.evidence);
  else blocked('V4_TERMINALIZATION_DATABASE_ERROR','DATABASE',{errorClass:error instanceof Error?error.name:'Error',safeMessage:error instanceof Error?error.message.slice(0,200):'database operation failed'});
 }
}

main();
