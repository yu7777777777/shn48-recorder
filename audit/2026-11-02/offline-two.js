const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const media=require('/app/server/modules/recorder/replay-download');
(async()=>{
 const base='/app/data/.replay-repair-two-20261102';
 const source=base+'/1323410706013163520',directory=base+'/candidate-1.32.4';
 assert.ok(!fs.existsSync(directory),'candidate directory must be new');fs.mkdirSync(directory);
 const plan=JSON.parse(fs.readFileSync(source+'/plan.json'));
 for(const name of ['plan.json',...plan.resources.map(r=>r.name)])fs.copyFileSync(path.join(source,name),path.join(directory,name));
 const result=await media.download({liveId:plan.liveId,directory,verify:true,getReplay:()=>{throw Error('offline only')},request:()=>{throw Error('offline only')}});
 const validation=JSON.parse(fs.readFileSync(directory+'/validation.json'));
 assert.equal(validation.method,'separate_tracks');
 assert.deepEqual(validation.expectedPackets,[{type:'video',packets:1817},{type:'audio',packets:14740}]);
 assert.deepEqual(validation.expectedPackets,validation.actualPackets);assert.equal(result.verification,'full');assert.ok(result.durationSeconds>373&&result.durationSeconds<375);
 console.log(JSON.stringify({recordingId:'rec_1793455319510_jc46a',...result,validation}));
 const second=base+'/1323401690805506048/verified.mp4';await media.verifyFull(second);
 assert.equal(await media.digest(second),'8862457497dcdd30176829411ad91cd00e81eaa762f2ffce9799b4bc7c14797d');
 const info=await media.probe(second);assert.ok(Number(info.format.duration)>330&&Number(info.format.duration)<331);
 console.log(JSON.stringify({recordingId:'rec_1793453189443_mbo87',durationSeconds:Number(info.format.duration),sha256:await media.digest(second),verification:'full'}));
})().catch(e=>{console.error(e);process.exit(1)});
