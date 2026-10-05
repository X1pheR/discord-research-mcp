'use strict';
async function refresh(client,clientId,clientSecret,state,fetcher=fetch){
 const refreshToken=state.read();
 let response,body;
 try{
  response=await fetcher('https://discord.com/api/oauth2/token',{
   method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},
   body:new URLSearchParams({client_id:clientId,client_secret:clientSecret,refresh_token:refreshToken,grant_type:'refresh_token'}),
   signal:AbortSignal.timeout(15000)
  });
  body=await response.json();
 }catch{throw new Error('oauth_unavailable');}
 if(!response.ok){
  const rejected=response.status===400||response.status===401||response.status===403;
  const error=new Error(rejected?'authentication_rejected':'oauth_unavailable');error.suspend=rejected;throw error;
 }
 if(typeof body.access_token!=='string'||!body.access_token||!Number.isFinite(body.expires_in)||body.expires_in<120)throw new Error('oauth_response_invalid');
 if(body.refresh_token)state.persist(body.refresh_token);
 await client.authenticate(body.access_token);
 return Date.now()+(body.expires_in-60)*1000;
}
module.exports={refresh};
