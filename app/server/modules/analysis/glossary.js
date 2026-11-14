"use strict";
// Glossary rows are the one place a member name is spelled by a human. Two rules
// keep that spelling usable everywhere else:
//  1. a term and its aliases are normalised (width/case/whitespace) so the same
//     name typed twice is the same row, and
//  2. a name that belongs to exactly one member can only appear under that row, so
//     an alias cannot silently endorse a conflicting reading elsewhere.
const MEMBER_ID=/^[0-9]{1,20}$/;
const NORMALIZE={nfkc:true,lower:false};
function fold(value){
  const text=String(value??"").normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g," ").replace(/\s+/g," ").trim().slice(0,80);
  return NORMALIZE.lower?text.toLowerCase():text;
}
// Comma/、/，all appear in pasted names; aliases are stored as one string.
// Normalising "小 熊" onto "小熊" would be a guess about who that is, so only
// outer whitespace is trimmed; inner spacing stays a distinct spelling.
function aliases(value){
 const parts=String(value??"").normalize("NFKC").split(/[,，、;；|]/).map(part=>part.replace(/[\u0000-\u001f\u007f]/g," ").replace(/\s+/g," ").trim().slice(0,80)).filter(Boolean);
 const seen=new Set();return parts.filter(part=>{if(seen.has(part))return false;seen.add(part);return true;}).join(", ").slice(0,160);
}
function memberId(row) {
  const raw=row&&(row.memberId??row.member?.id??row.personId);
  const text=raw===undefined||raw===null?"":String(raw).trim();
  return MEMBER_ID.test(text)?text:"";
}
function row(input){
 if(!input||typeof input!=="object")return null;
 const term=fold(input.term);if(!term)return null;
 return {term,aliases:aliases(input.aliases),enabled:input.enabled!==false,memberId:memberId(input)};
}
// Returns {value, conflicts}. Conflicts are reported, never silently merged: a
// wrong but plausible name would corrupt every later transcript.
function normalize(input,{limit=500}={}){
 if(!Array.isArray(input))throw Object.assign(new Error("词库格式无效"),{statusCode:400});
 if(input.length>limit)throw Object.assign(new Error(`词库最多 ${limit} 条`),{statusCode:400});
 const rows=[];const byTerm=new Map();const owners=new Map();const conflicts=[];
 for(const raw of input){
  const item=row(raw);if(!item)continue;
  const scan=[item.term].concat(item.aliases?item.aliases.split(", "):[]);
  for(const name of scan){
   const key=name;const owner=owners.get(key);
   if(owner===undefined)owners.set(key,item.memberId||"");
   else if(owner!==""&&item.memberId!==""&&owner!==item.memberId)conflicts.push({name,owners:[owner,item.memberId]});
  }
  const existing=byTerm.get(item.term);
  if(existing){if(item.aliases)existing.aliases=aliases([existing.aliases,item.aliases].filter(Boolean).join(","));existing.enabled=existing.enabled||item.enabled;if(item.memberId&&!existing.memberId)existing.memberId=item.memberId;}
  else{const copy={...item};byTerm.set(item.term,copy);rows.push(copy);}
 }
 // The same member can be described by several rows; that is not a conflict.
 const unique=[];for(const conflict of conflicts)if(!unique.some(other=>other.name===conflict.name&&other.owners[0]===conflict.owners[0]&&other.owners[1]===conflict.owners[1]))unique.push(conflict);
 return {value:rows,conflicts:unique};
}
module.exports={fold,aliases,memberId,normalize,NORMALIZE};