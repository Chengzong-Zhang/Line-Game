// Native issues a lease only after checking the challenge in the current main document.
export async function claimIOSDocument(plugin, challenge = globalThis.__LIFELINE_DOCUMENT_CHALLENGE__) {
  if (typeof challenge !== 'string' || !/^[a-f0-9]{64}$/.test(challenge)) throw new Error('Document challenge unavailable.');
  const lease = await plugin.claimDocument({documentChallenge:challenge});
  if (!lease || !Number.isSafeInteger(lease.pageEpoch) || lease.pageEpoch < 1
      || typeof lease.documentNonce !== 'string' || !lease.documentNonce) throw new Error('Document lease unavailable.');
  return Object.freeze({pageEpoch:lease.pageEpoch,documentNonce:lease.documentNonce});
}
