import type { SdkMethod } from './methods.generated.ts';

// twilio-node is generated from Twilio's specs at run time, so its method
// chains cannot be read from source the way the other SDKs are. These are the
// Messaging and Voice calls most integrations make, written against
// twilio_api_v2010.json. A chain step written `x()` takes a resource SID.
const account = '/2010-04-01/Accounts/{}';
const resource = (name: string, plural: string) => ({
  [`${name}.create`]: [{ e: `POST ${account}/${plural}.json`, p: 0, k: [] }],
  [`${name}.list`]: [{ e: `GET ${account}/${plural}.json`, p: 0, k: [] }],
  [`${name}.each`]: [{ e: `GET ${account}/${plural}.json`, p: 0, k: [] }],
  [`${name}.page`]: [{ e: `GET ${account}/${plural}.json`, p: 0, k: [] }],
  [`${name}().fetch`]: [{ e: `GET ${account}/${plural}/{}.json`, p: 0, k: [] }],
  [`${name}().update`]: [{ e: `POST ${account}/${plural}/{}.json`, p: 0, k: [] }],
  [`${name}().remove`]: [{ e: `DELETE ${account}/${plural}/{}.json`, p: 0, k: [] }],
});

export const twilioMethods: Record<string, SdkMethod[]> = {
  ...resource('messages', 'Messages'),
  ...resource('calls', 'Calls'),
  ...resource('incomingPhoneNumbers', 'IncomingPhoneNumbers'),
  ...resource('recordings', 'Recordings'),
  ...resource('conferences', 'Conferences'),
};
