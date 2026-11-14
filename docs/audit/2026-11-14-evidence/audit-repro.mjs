import {pathToFileURL} from 'node:url';
const AUDIT_REPO = process.env.SFGRAPH_AUDIT_REPO ?? '/tmp/sfgraph-audit-20261114';
const repoUrl = p => pathToFileURL(`${AUDIT_REPO}/${p}`);
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {SqliteGraphStore} = await import(repoUrl('packages/core/dist/storage/sqlite/graph-store.js'));
const {wrapConnectionReadOnly} = await import(repoUrl('packages/core/dist/extractors/live-org/read-only-proxy.js'));
const {parseMember} = await import(repoUrl('packages/core/dist/ingest/parse-member.js'));
const {findGovernorRisks} = await import(repoUrl('packages/core/dist/analyze/governor.js'));
const {populateGovernorRisks} = await import(repoUrl('packages/core/dist/analyze/populate.js'));
const {deadCodeCandidates} = await import(repoUrl('packages/core/dist/analyze/dead-code.js'));
const {securityAudit} = await import(repoUrl('packages/core/dist/analyze/security.js'));
import {mkdirSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

const req=createRequire(repoUrl('packages/core/package.json'));
const {Connection}=req('jsforce');
const conn=new Connection({instanceUrl:'https://example.invalid',accessToken:'AUDIT_FAKE_TOKEN'});
const requests=[];
// Intercept the SDK transport. No Salesforce connection or write is made.
conn.request=async(info)=>{requests.push(info);return {success:true,id:'AUDIT_FAKE_ID'};};
const ro=wrapConnectionReadOnly(conn);
await ro.apex.post('/audit-only',{name:'no-network'});
const before=requests.length;
await ro.sobject('Account')._conn.create('Account',{Name:'no-network'});
assert.equal(requests.length,before+1);
assert(requests.every(r=>r.method==='POST'));
console.log('PROXY_BYPASS',JSON.stringify(requests.map(r=>({method:r.method,url:r.url}))));
console.log('METADATA_RAW_CONNECTION',ro.metadata._conn===conn);

const orgId='00D000000000001AAA';
const store=new SqliteGraphStore({dbPath:':memory:'}); await store.init();
store.upsertOrg({id:orgId,alias:'audit',apiVersion:'65.0',instanceUrl:'',createdAt:1});
async function parse(type,name,content){
 const out=await parseMember({memberType:type,memberName:name,category:type,sourceUri:`file:///audit/${name}`,lastModifiedAt:'2020-01-01T00:00:00Z'},content,{orgId,parseTimestamp:new Date().toISOString()},{debug(){},info(){},warn(){},error(){}});
 assert.equal(out.kind,'parsed'); store.mergeNodes(out.result.nodes); store.mergeEdges(out.result.edges); return out.result;
}
const rest=await parse('ApexClass','PublicEndpoint',"@RestResource(urlMapping='/audit/*') global with sharing class PublicEndpoint { @HttpGet global static String read() { return 'ok'; } }");
const query=await parse('ApexClass','QueryAll','public class QueryAll { public static List<Account> load() { return [SELECT Id FROM Account]; } }');
const candidates=deadCodeCandidates(store,orgId);
assert(candidates.some(c=>String(c.node.qualifiedName)==='ApexClass:PublicEndpoint'));
console.log('REST_ENDPOINT_DEAD',JSON.stringify(candidates.filter(c=>String(c.node.qualifiedName).includes('PublicEndpoint')).map(c=>({name:c.node.qualifiedName,kind:c.kind}))));
console.log('QUERY_GRAPH',JSON.stringify(query.edges.filter(e=>e.relType==='EXECUTES_SOQL').map(e=>e.attributes)));
const direct=findGovernorRisks(store,orgId);populateGovernorRisks(store,orgId,store.db);
const cached=store.db.prepare('SELECT risk_type,qualified_name FROM _sfgraph_governor_risks').all();
assert(!direct.some(x=>x.risk==='unbounded_query'));assert(!cached.some(x=>x.risk_type==='unbounded_query'));
console.log('UNBOUNDED_QUERY_UNREPORTED',JSON.stringify({live:direct,cached}));

const fact=(label,name,attributes={})=>({orgId,label,qualifiedName:`${label}:${name}`,attributes,sourceHash:`hash-${label}-${name}`,firstSeenAt:1,lastSeenAt:1,lastModifiedAt:1});
store.mergeNodes([fact('CustomField','Account.Secret__c'),fact('PermissionSet','Reader')]);
store.mergeEdges([{orgId,srcQualifiedName:'PermissionSet:Reader',dstQualifiedName:'CustomField:account.secret__c',relType:'GRANTS_FIELD_ACCESS',attributes:{readable:true},firstSeenAt:1,lastSeenAt:1}]);
const sec=securityAudit(store,orgId);
console.log('SECURITY_CASE_MISMATCH',JSON.stringify(sec));
assert(sec.flsGaps.includes('CustomField:Account.Secret__c'));

const root=mkdtempSync(path.join(tmpdir(),'sfgraph-audit-repro-')); process.env.SFGRAPH_DATA_DIR=root;
const disk=new SqliteGraphStore({dbPath:path.join(root,`${orgId}.sqlite`)});await disk.init();
disk.upsertOrg({id:orgId,alias:'audit',apiVersion:'65.0',instanceUrl:'',createdAt:1});
disk.mergeNodes([fact('OmniScript','HiddenScript'),fact('CustomObject','Account'),fact('ApexClass','Consumer1'),fact('ApexClass','Consumer2'),fact('ApexClass','Consumer3')]);
disk.mergeEdges([1,2,3].map(i=>({orgId,srcQualifiedName:`ApexClass:Consumer${i}`,dstQualifiedName:'CustomObject:Account',relType:'REFERENCES_OBJECT',attributes:{},firstSeenAt:1,lastSeenAt:1})));
const web=await import(repoUrl('packages/web/dist/api.js'));
const full=await web.fullGraph(orgId,100);
assert(!full.nodes.some(n=>n.id==='OmniScript:HiddenScript'));assert.equal(full.truncated,false);
console.log('FULL_GRAPH_OMITS_LABEL',JSON.stringify({totalStored:disk.countNodes(orgId),shown:full.nodes.length,truncated:full.truncated,omitted:'OmniScript:HiddenScript'}));
const schema=await web.schema(orgId,2);const ids=new Set(schema.nodes.map(n=>n.id));const dangling=schema.edges.filter(e=>!ids.has(e.source)||!ids.has(e.target));
assert(dangling.length>0);
console.log('SCHEMA_DANGLING_EDGES',JSON.stringify({nodes:schema.nodes,edges:schema.edges,dangling: dangling.length}));
await web.closeAllStores();await disk.close();await store.close();
console.log('ALL_REPRODUCTIONS_CONFIRMED');
