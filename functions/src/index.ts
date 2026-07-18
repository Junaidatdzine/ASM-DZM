import { setGlobalOptions } from 'firebase-functions/v2';
import { onCall } from 'firebase-functions/v2/https';
import { initializeApp } from 'firebase-admin/app';
import { REGION } from './config';

initializeApp();

setGlobalOptions({
  region: REGION,
  maxInstances: 20,
  enforceAppCheck: false,
});

/** Health check used by the web app to verify functions wiring. */
export const ping = onCall(async (request) => {
  return {
    ok: true,
    now: Date.now(),
    authed: !!request.auth,
    emulator: process.env.FUNCTIONS_EMULATOR === 'true',
  };
});

export { authBootstrap } from './callable/bootstrap';
export {
  accessRequestResolve,
  allowlistRemove,
  allowlistUpdate,
  teamList,
  usersInvite,
  usersSetStatus,
  usersUpdate,
} from './callable/users';
export { storesAdd, storesDelete, storesRecolor, storesRename, storesTest, storesUpdateKey } from './callable/stores';
export { appsSyncOne, storesHardSync, storesSync } from './callable/sync';
export { locAddLanguage, locPush, locRemoveLanguage, versionsCreate, versionsUpdate } from './callable/localizations';
export { buildsList, versionInfoUpdate } from './callable/versionInfo';
export {
  ageRatingSave,
  appExtrasGet,
  customerReviewResponseDelete,
  customerReviewRespond,
  customerReviewsList,
  phasedReleaseSet,
  pricePointsList,
  priceScheduleSet,
  reviewAttachmentDelete,
  reviewAttachmentUpload,
  reviewDetailSave,
  reviewSubmissionCancel,
  reviewSubmit,
  subscriptionCreate,
  subscriptionGroupCreate,
  subscriptionSubmit,
  testflightTesterAdd,
  testflightTesterRemove,
  testflightTestersList,
} from './callable/appExtras';
export {
  screenshotSetsDelete,
  screenshotsDelete,
  screenshotsPollState,
  screenshotsReorder,
  screenshotsSyncAll,
  screenshotsSyncLocale,
  screenshotsUpload,
} from './callable/screenshots';
export { aiGenerate, aiReviewReply, aiTranslate } from './callable/ai';
export { settingsUpdate } from './callable/settings';
export { financeSync } from './callable/finance';
export { reportDaily, reportSendNow } from './callable/report';
export {
  admobConnect,
  admobOauthStatus,
  adsAccountRemove,
  adsAdGroupCreate,
  adsAdGroupUpdate,
  adsAdGroupsList,
  adsAppleConnect,
  adsCampaignCreate,
  adsCampaignSetStatus,
  adsCampaignSetup,
  adsCampaignUpdate,
  adsCampaignsList,
  adsKeywordRanks,
  adsKeywordUpdate,
  adsKeywordsCreate,
  adsKeywordsList,
  adsNegativeKeywordDelete,
  adsNegativeKeywordsAdd,
  adsNegativeKeywordsList,
  adsSearchTermsList,
  adsSync,
} from './callable/ads';
export { analyticsOverview } from './callable/analytics';
export { appsOverview } from './callable/overview';
export { bundleIdCreate, bundleIdDelete, bundleIdsList } from './callable/provisioning';
export { appDraftSummary } from './triggers/draftSummary';
