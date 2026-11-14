const net=require('net');
const assert=require('node:assert/strict');
const smtp=require('../../app/server/modules/notify/smtp');
(async()=>{
 let captured='',commands=[];
 const server=net.createServer(socket=>{
  socket.on('error',error=>{if(error.code!=='ECONNRESET')throw error;});
  socket.write('220 local SMTP test\r\n');let buffer='',inData=false;
  socket.on('data',chunk=>{
   buffer+=chunk;
   let end;
   while((end=buffer.indexOf('\r\n'))>=0){
    const line=buffer.slice(0,end);buffer=buffer.slice(end+2);
    if(inData){if(line==='.') {inData=false;socket.write('250 accepted\r\n');} else captured+=line+'\r\n';continue;}
    commands.push(line.split(' ')[0]);
    if(line.startsWith('EHLO'))socket.write('250-local\r\n250 8BITMIME\r\n');
    else if(line.startsWith('MAIL')||line.startsWith('RCPT'))socket.write('250 ok\r\n');
    else if(line==='DATA'){inData=true;socket.write('354 continue\r\n');}
    else if(line==='QUIT')socket.end('221 bye\r\n');
   }
  });
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  await smtp.send({host:'127.0.0.1',port:server.address().port,secure:false,from:'a@example.com',to:'b@example.com'},{title:'归档完成',text:'正文\n.点开头'});
  assert.deepEqual(commands.slice(0,4),['EHLO','MAIL','RCPT','DATA']);
  assert.ok(captured.includes('Subject: =?UTF-8?B?'));
  assert.ok(captured.includes('\r\n..点开头\r\n'));
  console.log('PASS SMTP protocol delivery, multiline response, UTF-8 and dot-stuffing');
 }finally{await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
