export const POOL_PAGE_SIZE=9;
export type PoolListingSection='v4_eligible'|'v4_checking'|'v4_no_active'|'v4_unavailable'|'v3_eligible';
export type PoolListingItem={section:PoolListingSection;label:string;data:string;detail?:string;rank?:number};
export type PoolListing={tokenSymbol:string;tokenAddress:string;items:PoolListingItem[];unavailableItems?:PoolListingItem[];counts:{v4Eligible:number;v3Eligible:number;v4Unavailable:number;zeroLiquidity:number;checking:number;unsupported:number;evidenceUnavailable?:number;notInitialized?:number}};
const sectionOrder:Record<PoolListingSection,number>={v4_eligible:0,v3_eligible:1,v4_unavailable:2,v4_checking:3,v4_no_active:4};
export function compactLabel(value:string,max=58){return value.length<=max?value:`${value.slice(0,Math.max(1,max-1))}…`;}
export function v4PoolSelectionLabel(targetSymbol:string,fundingSymbol:string,feeLabel:string){return compactLabel(`v4 · ${targetSymbol}/${fundingSymbol} · fee ${feeLabel}`);}
export function rankPoolListing(items:readonly PoolListingItem[]){return [...items].sort((a,b)=>sectionOrder[a.section]-sectionOrder[b.section]||(a.rank??Number.MAX_SAFE_INTEGER)-(b.rank??Number.MAX_SAFE_INTEGER)||a.label.localeCompare(b.label)||a.data.localeCompare(b.data));}
const executableSections=new Set<PoolListingSection>(['v4_eligible','v3_eligible']);
export function executablePoolListingItems(listing:PoolListing){return listing.items.filter(item=>executableSections.has(item.section));}
export function unavailablePoolListingItems(listing:PoolListing){return listing.unavailableItems??listing.items.filter(item=>item.section==='v4_unavailable');}
export function poolListingPage(listing:PoolListing,page:number,pageSize=POOL_PAGE_SIZE){const executable=executablePoolListingItems(listing),totalPages=Math.max(1,Math.ceil(executable.length/pageSize)),current=Math.min(Math.max(0,page),totalPages-1),start=current*pageSize,items=executable.slice(start,start+pageSize);return {current,totalPages,items,hasPrevious:current>0,hasNext:current+1<totalPages};}
export function unavailablePoolListingPage(listing:PoolListing,page:number,pageSize=POOL_PAGE_SIZE){const items=unavailablePoolListingItems(listing),totalPages=Math.max(1,Math.ceil(items.length/pageSize)),current=Math.min(Math.max(0,page),totalPages-1),start=current*pageSize;return {current,totalPages,items:items.slice(start,start+pageSize),hasPrevious:current>0,hasNext:current+1<totalPages};}
function foundCount(counts:PoolListing['counts']){return counts.v4Eligible+counts.v3Eligible+(counts.zeroLiquidity??0)+(counts.checking??0)+(counts.notInitialized??0)+(counts.evidenceUnavailable??0)+(counts.unsupported??0);}
export function directLookupAcknowledgementText(tokenSymbol:string,tokenAddress:string,counts:PoolListing['counts']){return [`${tokenSymbol} (${tokenAddress})`,`Pools found: ${foundCount(counts)}`,`Eligible v4: ${counts.v4Eligible} · eligible v3: ${counts.v3Eligible}`,`Checking: ${counts.checking??0} · No active liquidity: ${counts.zeroLiquidity??0} · Evidence unavailable: ${counts.evidenceUnavailable??0} · Unsupported: ${counts.unsupported??0}`,'Refreshing exact pool state…'].join('\n');}
export function poolListingSummary(listing:PoolListing,page:number,pageSize=POOL_PAGE_SIZE){const view=poolListingPage(listing,page,pageSize),zero=listing.counts.zeroLiquidity??0,checking=listing.counts.checking??0,unsupported=listing.counts.unsupported??0,unavailable=listing.counts.evidenceUnavailable??0,notInitialized=listing.counts.notInitialized??0;return [`${listing.tokenSymbol} (${listing.tokenAddress})`,`Pools found: ${foundCount(listing.counts)}`,`Eligible v4: ${listing.counts.v4Eligible} · eligible v3: ${listing.counts.v3Eligible}`,`Checking: ${checking} · No active liquidity: ${zero} · Not initialized: ${notInitialized} · Evidence unavailable: ${unavailable} · Unsupported: ${unsupported}`,...(view.items.length?[]:['No executable pools currently found.']),`v4 prioritized.`, `Page ${view.current+1}/${view.totalPages}`].join('\n');}

export type DirectLookupEvidenceSummary={structuralCandidateCount:number;zeroLiquidityCandidateCount:number;notInitializedCandidateCount:number;unavailableCandidateCount:number};
export function directLookupTerminalEvidenceText(status:string,evidence:DirectLookupEvidenceSummary){
 if(evidence.structuralCandidateCount===0&&status==='NO_ACTIVE_LIQUIDITY_POOL')return 'No structurally supported USDG/WETH V4/V3 pool found under current FUNI policy.';
 if(evidence.structuralCandidateCount===0)return 'Pool evidence is temporarily unavailable. Refresh to re-check.';
 const zero=evidence.zeroLiquidityCandidateCount,notInitialized=evidence.notInitializedCandidateCount,unavailable=evidence.unavailableCandidateCount;
 if(zero>0&&!notInitialized&&!unavailable)return `${zero} supported V4 pool${zero===1?'':'s'} found, but fresh StateView active liquidity is 0.`;
 const parts=[zero?`${zero} zero-liquidity`:null,notInitialized?`${notInitialized} not initialized`:null,unavailable?`${unavailable} evidence unavailable`:null].filter((value):value is string=>Boolean(value));
 const retry=status==='PROVIDER_TEMPORARILY_UNAVAILABLE'||status==='LOOKUP_TIMED_OUT'||unavailable>0;
 return `No executable pool confirmed${retry?' yet':''}.${parts.length?` ${parts.join(' · ')}.`:''}${retry?' Refresh to re-check.':''}`;
}
