"use strict";
const router=require('express').Router();
const service=require('../modules/analysis/service');
const settings=require('../modules/analysis/settings');
function exportProfile(req,res) {
  const profile=require('../modules/analysis/export-profiles').resolve(req.query.profile);
  if (!profile) return;
  // Parameter metadata only: the existing SRT/summary body is not a media encode.
  res.setHeader('X-Export-Profile',profile.profile);
  res.setHeader('X-Export-Parameters',JSON.stringify(profile));
  res.setHeader('X-Export-Encoding','unchanged');
}
const wrap=fn=>async(req,res)=>{try{res.json({success:true,data:await fn(req,res)});}catch(e){res.status(e.statusCode||400).json({success:false,error:e.message});}};
router.get('/settings',wrap(()=>settings.publicSettings()));
router.get('/queue',wrap(()=>service.queueStatus()));
router.get('/oss/status',wrap(()=>require('../modules/analysis/oss-sync').status()));
router.put('/settings',wrap(req=>settings.save(req.body)));
router.post('/settings/:kind/models',wrap(req=>settings.models(req.params.kind, req.body)));
router.post('/settings/asr/test',wrap(req=>require('../modules/analysis/probe').test(req.body)));
router.post('/settings/ai/test',wrap(req=>require('../modules/analysis/text-probe').test(req.body)));
router.get('/offline/status',wrap(()=>require('../modules/analysis/offline').status()));
router.post('/offline/install',wrap(req=>require('../modules/analysis/offline').install(req.body.model)));
router.post('/offline/test',wrap(req=>require('../modules/analysis/offline').test(req.body.model)));
router.post('/replay/preview',wrap(req=>require('../modules/analysis/replay-intake').preview(req.body?.source)));
router.post('/replay/import',wrap(req=>{if(req.body?.confirmed!==true)throw Object.assign(new Error('请先确认完整下载并核对预览信息'),{statusCode:400});return require('../modules/analysis/replay-intake').confirm(req.body?.previewId);}));
router.get('/replay/import/:id',wrap(req=>require('../modules/recorder/replay-import').get(req.params.id)));
router.post('/:id/restore-original',wrap(req=>service.restoreOriginal(req.params.id)));
router.patch('/:id/segments/:index',wrap(req=>service.editSegment(req.params.id,req.params.index,req.body?.text)));
router.get('/:id',wrap(req=>service.result(req.params.id)));
router.post('/:id',wrap(req=>service.enqueue(req.params.id,req.body.kind,{target:req.body?.target})));
router.post('/:id/cancel',wrap(req=>{service.cancel(req.params.id);return {cancelled:true};}));
// Irreversible: the service keeps a snapshot and refuses while a task is running.
router.delete('/:id',wrap(req=>{if(req.body?.confirmed!==true)throw Object.assign(new Error('请先确认清空这条归档的字幕与分析'),{statusCode:400});return service.clearAnalysis(req.params.id);}));
router.post('/:id/import-srt',wrap(req=>service.importSrt(req.params.id,req.body)));
router.get('/:id/subtitles', (req,res)=>{try{exportProfile(req,res);const data=service.result(req.params.id);res.setHeader('Content-Disposition','attachment; filename="subtitles.srt"');res.type('text/plain').send(service.subtitle(data.segments,req.query.language));}catch(e){res.status(e.statusCode||400).json({success:false,error:e.message});}});
router.get('/:id/summary', (req,res)=>{
  try {
    exportProfile(req,res);
    const exported=require('../modules/analysis/export').render(req.params.id,service.result(req.params.id),req.query.format || 'markdown');
    res.setHeader('Content-Disposition', 'attachment; filename="summary.' + exported.extension + '"');
    res.setHeader('Cache-Control','private, no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.type(exported.type).send(exported.text);
  } catch(e) { res.status(e.statusCode||400).json({success:false,error:e.message}); }
});
router.get('/:id/provenance', (req,res)=>{
  try {
    // Same record, two readable formats: JSON for tooling, Markdown for a person.
    const format = String(req.query.format || 'json').toLowerCase();
    if (!['json', 'markdown'].includes(format)) throw Object.assign(new Error('导出格式无效，请选择 json 或 markdown'), {statusCode:400});
    const exporter = require('../modules/analysis/export');
    const data = service.result(req.params.id);
    const body = format === 'markdown' ? exporter.renderProvenanceText(data) : exporter.renderProvenance(data);
    res.setHeader('Content-Disposition', 'attachment; filename="analysis-provenance.' + (format === 'markdown' ? 'md' : 'json') + '"');
    res.setHeader('Cache-Control','private, no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.type(format === 'markdown' ? 'text/markdown' : 'application/json').send(body);
  } catch(e) { res.status(e.statusCode||400).json({success:false,error:e.message}); }
});
// Batch provenance for audits: an aggregation of the same per-recording records,
// built under the same rules (host-only providers, no URLs or secrets). The caller
// names the ids explicitly so this can never sweep every archive by accident.
router.post('/provenance/batch', (req,res)=>{
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
    if (!ids) throw Object.assign(new Error('请提供要导出的归档列表'), {statusCode:400});
    const format = String(req.body?.format || 'json').toLowerCase();
    if (!['json', 'csv'].includes(format)) throw Object.assign(new Error('导出格式无效，请选择 json 或 csv'), {statusCode:400});
    const exporter = require('../modules/analysis/export');
    // A CSV row per archive needs the title and whether it was ever analysed, which
    // the analysis record alone cannot say; the recording lookup stays local.
    const summary = require('../modules/recorder/manager').getRecordings();
    const titles = new Map((Array.isArray(summary) ? summary : []).map(item => [String(item.id), item.title || '']));
    const records = ids.map(id => ({ recordingId: String(id), title: titles.get(String(id)) || '' }));
    if (format === 'csv') {
      const exported = exporter.csvProvenance(records.map(record => {
        try { return { ...record, analyzed: true, ...exporter.provenance(service.result(record.recordingId)) }; }
        catch (error) { return { ...record, analyzed: false }; }
      }));
      res.setHeader('Content-Disposition', 'attachment; filename="analysis-provenance-batch.csv"');
      res.setHeader('Cache-Control','private, no-store');
      res.setHeader('X-Content-Type-Options','nosniff');
      res.type('text/csv').send('\uFEFF' + exported);
      return;
    }
    const exported = exporter.batchProvenance(ids.map(id=>service.result(id)));
    res.setHeader('Content-Disposition', 'attachment; filename="analysis-provenance-batch.json"');
    res.setHeader('Cache-Control','private, no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.type('application/json').send(exported);
  } catch(e) { res.status(e.statusCode||400).json({success:false,error:e.message}); }
});
module.exports=router;
