'use strict';
const O = require('./observations');
const EVENTS = ['MESSAGE_CREATE', 'MESSAGE_UPDATE', 'MESSAGE_DELETE'];
const THREAD_TYPES = new Set([10, 11, 12]);
const FORUM_TYPE = 15;
function array(value, key) {
  if (key && value?.[key]) return array(value[key]);
  if (Array.isArray(value)) return value;
  if (value instanceof Map) return [...value.values()];
  return value && typeof value === 'object' ? Object.values(value) : [];
}
function channelId(value) {
  const id = value?.id;
  return id === null || id === undefined ? '' : String(id);
}
function parentId(value) {
  const id = value?.parent_id;
  return id === null || id === undefined ? '' : String(id);
}
function isThread(value) {
  return THREAD_TYPES.has(Number(value?.type));
}
// The injected provider is the existing authenticated RPC client, not a collector.
class Session {
  constructor(client, sources, emit, health, options={}) {
    this.client=client; this.sources=O.validateSelection({version:1,sources});
    this.emit=emit; this.health=health; this.chain=Promise.resolve();
    this.channels=new Map(); this.listeners=[]; this.subscriptions=[];
    this.forumParents=new Map(); this.derived=new Map(); this.forumState=options.forumState||null; this.revalidationFailures=0;
    this.state={selected:this.sources,active:[],derived:[],source_coverage:[],coverage:'unknown',status:'starting',gap:true,reason:'start',last_interaction:null,last_observation:null};
  }
  report(delta) {Object.assign(this.state,delta); this.health(JSON.parse(JSON.stringify(this.state)));}
  coverageState() {
    const source_coverage=this.sources.map(source=>{
      const channel=this.channels.get(source.channel_id);
      const forum=Number(channel?.type)===FORUM_TYPE;
      return {
        guild_id:source.guild_id,
        channel_id:source.channel_id,
        channel_type:channel?.type ?? null,
        coverage:forum?'unsupported_forum_children':'observed_forward_events_only',
        complete:false,
      };
    });
    return {
      coverage:source_coverage.some(item=>item.coverage==='unsupported_forum_children')
        ? 'partial_selected_sources'
        : 'observed_forward_events_only',
      source_coverage,
    };
  }
  derivedState() {
    return [...this.derived.values()].map(value=>({
      guild_id:value.guild_id,
      channel_id:value.channel_id,
      parent_id:value.parent_id,
    }));
  }
  addDerived(channel) {
    const id=channelId(channel), parent=parentId(channel);
    if (!id || !parent || !isThread(channel)) return false;
    const selectedParent=this.forumParents.get(parent);
    if (!selectedParent) return false;
    if (channel.guild_id && String(channel.guild_id)!==selectedParent.guild_id) return false;
    const normalized=O.normalizeChannel({...channel,guild_id:selectedParent.guild_id});
    if (normalized.parent_id!==parent) return false;
    this.channels.set(id,normalized);
    this.derived.set(id,{guild_id:selectedParent.guild_id,channel_id:id,parent_id:parent});
    return true;
  }
  async subscribeChannel(id) {
    for (const event of EVENTS) this.subscriptions.push(await this.client.subscribe(event,{channel_id:id}));
  }
  installMessageListeners() {
    for (const event of EVENTS) {
      const listener=data=>{this.chain=this.chain.then(()=>this.event(event,data)).catch(()=>this.report({status:'degraded',gap:true,reason:'event_processing_failed'}));};
      this.client.on(event,listener); this.listeners.push([event,listener]);
    }
  }
  async channelCreate(data) {
    const id=channelId(data);
    if (!id || this.channels.has(id) || !isThread(data)) return;
    let channel;
    try {channel=await this.client.getChannel(id);} catch {this.report({status:'degraded',gap:true,reason:'forum_child_identity_unavailable'});return;}
    if (channelId(channel)!==id) {this.report({status:'degraded',gap:true,reason:'provider_identity_mismatch'});return;}
    if (!this.addDerived(channel)) return;
    if(this.forumState) this.forumState.merge([this.derived.get(id)]);
    await this.subscribeChannel(id);
    this.report({derived:this.derivedState(),last_interaction:new Date().toISOString()});
  }
  async start() {
    if (!this.sources.length) {this.report({status:'disabled',reason:'empty_selection'}); return;}
    const disconnected=()=>this.report({status:'degraded',active:[],gap:true,reason:'provider_disconnected'});
    this.client.on('disconnected',disconnected); this.listeners.push(['disconnected',disconnected]);
    const guilds=array(await this.client.getGuilds(),'guilds');
    const metadataByGuild=new Map();
    for (const source of this.sources) {
      if (!guilds.some(g=>String(g.id)===source.guild_id)) throw new Error('selected_identity_unavailable');
      let channels=metadataByGuild.get(source.guild_id);
      if (!channels) {
        channels=array(await this.client.getChannels(source.guild_id),'channels');
        metadataByGuild.set(source.guild_id,channels);
      }
      const channel=channels.find(c=>channelId(c)===source.channel_id);
      if (!channel || (channel.guild_id && String(channel.guild_id)!==source.guild_id)) throw new Error('selected_identity_mismatch');
      const normalized=O.normalizeChannel({...channel,guild_id:source.guild_id});
      this.channels.set(source.channel_id,normalized);
      if (Number(normalized.type)===FORUM_TYPE) this.forumParents.set(source.channel_id,source);
    }
    const discovered=[];
    for (const channels of metadataByGuild.values()) for (const channel of channels) {
      if(this.addDerived(channel)) discovered.push(this.derived.get(channelId(channel)));
    }
    if(this.forumState){
      const persisted=this.forumState.read();
      let failures=0;
      for(const entry of persisted){
        if(!this.forumParents.has(entry.parent_id)) continue;
        try{
          const channel=await this.client.getChannel(entry.channel_id);
          if(channelId(channel)!==entry.channel_id||!this.addDerived(channel)) failures++;
        }catch{failures++;}
      }
      if(discovered.length) this.forumState.merge(discovered);
      this.revalidationFailures=failures;
      if(failures) this.report({status:'degraded',gap:true,reason:'forum_state_revalidation_failed',derived:this.derivedState()});
    }
    this.installMessageListeners();
    for (const id of this.channels.keys()) await this.subscribeChannel(id);
    const created=data=>{this.chain=this.chain.then(()=>this.channelCreate(data)).catch(()=>this.report({status:'degraded',gap:true,reason:'forum_child_discovery_failed'}));};
    this.client.on('CHANNEL_CREATE',created); this.listeners.push(['CHANNEL_CREATE',created]);
    this.subscriptions.push(await this.client.subscribe('CHANNEL_CREATE'));
    this.report({
      active:this.sources,derived:this.derivedState(),...this.coverageState(),
      status:this.revalidationFailures?'degraded':'subscribed',
      reason:this.revalidationFailures?'forum_state_revalidation_failed':null,
      last_interaction:new Date().toISOString(),
    });
  }
  async event(event,data) {
    if (!this.state.active.length) return;
    let message=O.eventMessage(data);
    const id=String(data?.channel_id || message?.channel_id || '');
    const channel=this.channels.get(id);
    if (!channel) return;
    const mismatch=m=> (m?.channel_id && String(m.channel_id)!==id) ||
      (m?.guild_id && String(m.guild_id)!==channel.guild_id);
    if (mismatch(message)) {
      this.report({status:'degraded',gap:true,reason:'event_identity_mismatch'}); return;
    }
    const source=O.deriveSourceIdentity(channel,this.client.user);
    let observation;
    if (event==='MESSAGE_DELETE') observation={...O.deleteObservation(O.eventMessageId(data),source),channel_id:id,...(channel.parent_id?{parent_id:String(channel.parent_id)}:{})};
    else {
      const messageId=O.eventMessageId(data);
      if (!messageId) {this.report({status:'degraded',gap:true,reason:'missing_message_id'}); return;}
      if (!O.completeEventMessage(data)) {
        const refreshed=await this.client.getChannel(id);
        if (String(refreshed?.id)!==id || (refreshed.guild_id && String(refreshed.guild_id)!==channel.guild_id)) {
          this.report({status:'degraded',active:[],gap:true,reason:'provider_identity_mismatch'}); return;
        }
        message=O.findMessage(refreshed,messageId);
        if (!O.completeEventMessage(message)) {
          this.report({status:'degraded',gap:true,reason:'complete_message_unavailable'}); return;
        }
      }
      if (mismatch(message)) {this.report({status:'degraded',gap:true,reason:'event_identity_mismatch'}); return;}
      observation=O.messageObservation(channel,message,source);
    }
    this.emit(observation);
    this.report({last_observation:new Date().toISOString()});
  }
  drain() {return this.chain;}
  async stop() {
    for (const [event,listener] of this.listeners) this.client.removeListener(event,listener);
    for (const subscription of this.subscriptions.reverse()) await subscription.unsubscribe();
    await this.drain(); this.report({status:'stopped',active:[],gap:true,reason:'stopped'});
  }
}
module.exports={Session};
