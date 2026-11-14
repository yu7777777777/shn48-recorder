"use strict";
const {createHash}=require("node:crypto");
// One instruction per language. Each is hashed into every segment it produced, so
// a translation made for another target (or under different wording) is never
// presented as current.
const TARGETS={
  en:{version:"en-v1",instruction:"将字幕逐条翻译成英文。返回 {\"translations\":[{\"id\":数字,\"text\":\"英文\"}]}；保留每个 id，不能遗漏。"},
  ja:{version:"ja-v1",instruction:"将字幕逐条翻译成日文。返回 {\"translations\":[{\"id\":数字,\"text\":\"日文\"}]}；保留每个 id，不能遗漏。"}
};
const DEFAULT_TARGET="en";
const INSTRUCTION=TARGETS[DEFAULT_TARGET].instruction;
const VERSION=TARGETS[DEFAULT_TARGET].version;
// The segment column is named after the language, so English keeps its old shape
// and older translations stay readable without a migration.
function column(target){return target==="en"?"en":"en" + String(target).toUpperCase();}
function targetOf(value){return Object.prototype.hasOwnProperty.call(TARGETS,String(value||""))?String(value||""):DEFAULT_TARGET;}
function hash(value){return createHash("sha256").update(String(value??"")).digest("hex").slice(0,16);}
function identity(config,target=DEFAULT_TARGET){const name=targetOf(target),spec=TARGETS[name];return {$v:spec.version,target:name,endpoint:String(config?.url??""),model:String(config?.model??""),instruction:hash(spec.instruction)};}
function same(a,b){if(!a||!b)return false;const left=targetOf(a.target),right=targetOf(b.target);return left===right&&a.$v===b.$v&&a.endpoint===b.endpoint&&a.model===b.model&&a.instruction===b.instruction;}
// A segment is reusable only when it carries the exact identity it was made with
// and its source text is unchanged. Legacy rows with bare `en` are never reused.
function reusable(segment,id){if(!segment)return false;const name=targetOf(id?.target),value=segment[column(name)];return Boolean(typeof value==="string"&&value.trim())&&same(segment.translation,id)&&segment.enSource===hash(segment.text);}
function stamp(segment,text,id){const name=targetOf(id?.target);return {...segment,[column(name)]:String(text).slice(0,10000),enSource:hash(segment.text),translation:{...id,target:name}};}
function stale(segment,id){return !reusable(segment,id);}
module.exports={INSTRUCTION,VERSION,TARGETS,DEFAULT_TARGET,column,targetOf,identity,same,reusable,stamp,stale,hash};
