import asyncio, pathlib, tomllib, json
from mcp import ClientSession
from mcp.client.sse import sse_client
async def main():
    config=tomllib.loads((pathlib.Path.home()/'.codex'/'config.toml').read_text(encoding='utf-8'))
    env=config['mcp_servers']['dstatus']['env']
    async with sse_client(env['DSTATUS_MCP_URL'],headers={'Authorization':'Bearer '+env['DSTATUS_MCP_TOKEN']},timeout=25,sse_read_timeout=60) as (r,w):
      async with ClientSession(r,w) as s:
        await s.initialize()
        ts=await s.list_tools()
        matches=[t for t in ts.tools if 'list' in t.name.lower() and 'server' in t.name.lower()]
        print('SERVER_LIST_TOOLS',[(t.name,t.input_schema) for t in matches])
        for tool in matches[:1]:
          out=await s.call_tool(tool.name,{})
          print(out.model_dump_json())
asyncio.run(main())
