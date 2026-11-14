"""Versioned faster-whisper worker. Inference never downloads or uploads data."""
import os, sys, json
cpu_threads = max(1, int(os.environ.get('ASR_CPU_THREADS', min(4, os.cpu_count() or 1))))
os.environ['OMP_NUM_THREADS'] = str(cpu_threads)
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
os.environ['HF_HUB_DISABLE_XET'] = '1'
try:
    os.nice(10)
except (AttributeError, OSError):
    pass
request = json.load(sys.stdin)
name = request['model']
if name not in ('tiny', 'base', 'small'):
    raise ValueError('unsupported model')
# Pinned commits only: the model is verified on install and reused offline, so an
# unpinned revision would let a remote update silently change every later transcript.
revisions = {
    'tiny': 'd90ca5fe260221311c53c58e660288d3deb8d356',
    'base': 'ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66',
    'small': '536b0662742cf9da4f2d0b7380c4c62bb7015b8c',
}
directory = os.path.join(request['root'], name)
from faster_whisper import WhisperModel
if request['action'] == 'install':
    from huggingface_hub import snapshot_download
    snapshot_download('Systran/faster-whisper-' + name, local_dir=directory, revision=revisions[name],
                      allow_patterns=['model.bin', 'config.json', 'tokenizer.json', 'vocabulary.*'], max_workers=1)
    model = WhisperModel(directory, device='cpu', compute_type='int8', cpu_threads=cpu_threads, local_files_only=True)
    with open(os.path.join(directory, '.ready.tmp'), 'w') as f:
        f.write('faster-whisper=1.2.1\\nrevision=' + revisions[name] + '\\n')
    os.replace(os.path.join(directory, '.ready.tmp'), os.path.join(directory, '.ready'))
    print(json.dumps({'installed': True, 'model': name}))
else:
    os.environ['HF_HUB_OFFLINE'] = '1'
    if not os.path.isfile(os.path.join(directory, '.ready')):
        raise ValueError('model not installed')
    model = WhisperModel(directory, device='cpu', compute_type='int8', cpu_threads=cpu_threads, local_files_only=True)
    segments, info = model.transcribe(request['file'], language='zh', beam_size=int(os.environ.get('ASR_BEAM_SIZE', '1')),
                                      vad_filter=True, condition_on_previous_text=False,
                                      initial_prompt=request.get('prompt') or None)
    print(json.dumps({'segments': [{'start': s.start, 'end': s.end, 'text': s.text} for s in segments]}, ensure_ascii=False))