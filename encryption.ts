// encryption.ts
import * as libsignal from 'libsignal-protocol-javascript';
import { v4 as uuidv4 } from 'uuid';

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function padPlaintext(message: Uint8Array): Uint8Array {
  const size = message.length;
  const paddedSize = size + 2 + ((160 - (size + 2) % 160) % 160);
  const padded = new Uint8Array(paddedSize);
  padded[0] = (size >> 8) & 0xff;
  padded[1] = size & 0xff;
  padded.set(message, 2);
  return padded;
}

function unpadPlaintext(padded: Uint8Array): Uint8Array {
  const size = (padded[0] << 8) | padded[1];
  return padded.subarray(2, 2 + size);
}

// GroupSessionBuilder
export class GroupSessionBuilder {
  private senderKeyStore: any;

  constructor(senderKeyStore: any) {
    this.senderKeyStore = senderKeyStore;
  }

  process(senderKeyName: any, senderKeyDistributionMessage: any) {
    const senderKeyRecord = this.senderKeyStore.loadSenderKey(senderKeyName);
    senderKeyRecord.addSenderKeyState(
      senderKeyDistributionMessage.id,
      senderKeyDistributionMessage.iteration,
      senderKeyDistributionMessage.chainKey,
      senderKeyDistributionMessage.signatureKey
    );
    this.senderKeyStore.storeSenderKey(senderKeyName, senderKeyRecord);
  }

  create(senderKeyName: any) {
    let senderKeyRecord = this.senderKeyStore.loadSenderKey(senderKeyName);

    if (senderKeyRecord.isEmpty()) {
      const keyId = libsignal.KeyHelper.generateSenderKeyId();
      const iteration = 0;
      const chainKey = libsignal.KeyHelper.generateSenderKey();
      const signingKey = libsignal.KeyHelper.generateSenderSigningKey();

      senderKeyRecord.setSenderKeyState(keyId, iteration, chainKey, signingKey);
      this.senderKeyStore.storeSenderKey(senderKeyName, senderKeyRecord);
    }

    const state = senderKeyRecord.getSenderKeyState();

    return new libsignal.SenderKeyDistributionMessage(
      state.getKeyId(),
      state.getSenderChainKey().getIteration(),
      state.getSenderChainKey().getSeed(),
      state.getSigningKeyPublic()
    );
  }
}

// GroupCipher
export class GroupCipher {
  private senderKeyStore: any;
  private senderKeyName: any;

  constructor(senderKeyStore: any, senderKeyName: any) {
    this.senderKeyStore = senderKeyStore;
    this.senderKeyName = senderKeyName;
  }

  encrypt(paddedPlaintext: Uint8Array): Uint8Array {
    const record = this.senderKeyStore.loadSenderKey(this.senderKeyName);
    if (record.isEmpty()) {
      throw new Error('No session');
    }
    const senderKeyState = record.getSenderKeyState();
    const senderKey = senderKeyState.getSenderChainKey().getSenderMessageKey();
    const ciphertext = libsignal.crypto.encrypt(senderKey.getCipherKey(), paddedPlaintext, senderKey.getIv());

    const senderKeyMessage = new libsignal.SenderKeyMessage(
      senderKeyState.getKeyId(),
      senderKey.getIteration(),
      ciphertext,
      senderKeyState.getSigningKeyPrivate()
    );

    senderKeyState.setSenderChainKey(senderKeyState.getSenderChainKey().getNext());
    this.senderKeyStore.storeSenderKey(this.senderKeyName, record);

    return senderKeyMessage.serialize();
  }

  decrypt(senderKeyMessageBytes: Uint8Array): Uint8Array {
    const record = this.senderKeyStore.loadSenderKey(this.senderKeyName);
    if (record.isEmpty()) {
      throw new Error('No session');
    }

    const senderKeyMessage = new libsignal.SenderKeyMessage(senderKeyMessageBytes);
    const senderKeyState = record.getSenderKeyState(senderKeyMessage.getKeyId());

    senderKeyMessage.verifySignature(senderKeyState.getSigningKeyPublic());

    const senderKey = this.getSenderKey(senderKeyState, senderKeyMessage.getIteration());

    const plaintext = libsignal.crypto.decrypt(senderKey.getCipherKey(), senderKeyMessage.getCipherText(), senderKey.getIv());

    this.senderKeyStore.storeSenderKey(this.senderKeyName, record);

    return plaintext;
  }

  private getSenderKey(senderKeyState: any, iteration: number): any {
    let senderChainKey = senderKeyState.getSenderChainKey();

    if (senderChainKey.getIteration() > iteration) {
      if (senderKeyState.hasSenderMessageKey(iteration)) {
        return senderKeyState.removeSenderMessageKey(iteration);
      } else {
        throw new Error(`Duplicate message`);
      }
    }

    if (iteration - senderChainKey.getIteration() > 2000) {
      throw new Error('Message too far in future');
    }

    while (senderChainKey.getIteration() < iteration) {
      senderKeyState.addSenderMessageKey(senderChainKey.getSenderMessageKey());
      senderChainKey = senderChainKey.getNext();
    }

    senderKeyState.setSenderChainKey(senderChainKey.getNext());
    return senderChainKey.getSenderMessageKey();
  }
}

// LocalStorageStore (implements SignalProtocolStore interfaces)
export class LocalStorageStore {
  constructor() {}

  // IdentityKeyStore
  async getIdentityKeyPair() {
    const pair = localStorage.getItem('identityKey');
    return pair ? JSON.parse(pair) : null;
  }

  async getLocalRegistrationId() {
    const id = localStorage.getItem('registrationId');
    return id ? parseInt(id) : 0;
  }

  async put(key: string, value: any) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  async isTrustedIdentity(identifier: string, identityKey: any, direction: number) {
    return true; // Trust on first use (simplified for demo)
  }

  async loadIdentityKey(identifier: string) {
    return JSON.parse(localStorage.getItem(`25519KeyidentityKey${identifier}`) || 'null');
  }

  async saveIdentity(identifier: string, identityKey: any) {
    localStorage.setItem(`25519KeyidentityKey${identifier}`, JSON.stringify(identityKey));
  }

  // PreKeyStore
  async loadPreKey(preKeyId: number) {
    return JSON.parse(localStorage.getItem(`25519KeypreKey${preKeyId}`) || 'null');
  }

  async storePreKey(preKeyId: number, preKeyPair: any) {
    localStorage.setItem(`25519KeypreKey${preKeyId}`, JSON.stringify(preKeyPair));
  }

  async removePreKey(preKeyId: number) {
    localStorage.removeItem(`25519KeypreKey${preKeyId}`);
  }

  // SignedPreKeyStore
  async loadSignedPreKey(signedPreKeyId: number) {
    return JSON.parse(localStorage.getItem(`25519KeysignedKey${signedPreKeyId}`) || 'null');
  }

  async storeSignedPreKey(signedPreKeyId: number, record: any) {
    localStorage.setItem(`25519KeysignedKey${signedPreKeyId}`, JSON.stringify(record));
  }

  // SessionStore
  async loadSession(identifier: string) {
    return JSON.parse(localStorage.getItem(`session${identifier}`) || 'null');
  }

  async storeSession(identifier: string, record: any) {
    localStorage.setItem(`session${identifier}`, JSON.stringify(record));
  }

  // SenderKeyStore
  async storeSenderKey(senderKeyName: any, keyRecord: any) {
    localStorage.setItem(this.getSenderKeyNameString(senderKeyName), JSON.stringify(keyRecord));
  }

  async loadSenderKey(senderKeyName: any) {
    const serialized = localStorage.getItem(this.getSenderKeyNameString(senderKeyName));
    if (serialized) {
      return new libsignal.SenderKeyRecord(JSON.parse(serialized));
    }
    return new libsignal.SenderKeyRecord();
  }

  private getSenderKeyNameString(senderKeyName: any) {
    return `${senderKeyName.groupId}::${senderKeyName.sender.name}::${senderKeyName.sender.deviceId}`;
  }
}

export async function initSignalStore(store: LocalStorageStore) {
  if (!await store.getIdentityKeyPair()) {
    const registrationId = libsignal.KeyHelper.generateRegistrationId();
    await store.put('registrationId', registrationId);
    const identityKey = libsignal.KeyHelper.generateIdentityKeyPair();
    await store.put('identityKey', identityKey);
    const signedPreKey = libsignal.KeyHelper.generateSignedPreKey(identityKey, 1);
    await store.storeSignedPreKey(1, signedPreKey.keyPair);
    const preKey = libsignal.KeyHelper.generatePreKey(5);
    await store.storePreKey(5, preKey.keyPair);
  }
}

export async function getPrekeyBundle(store: LocalStorageStore) {
  const identity = await store.getIdentityKeyPair();
  const registrationId = await store.getLocalRegistrationId();
  const signedPreKey = await store.loadSignedPreKey(1);
  const oneTimePreKey = await store.loadPreKey(5);
  const signature = libsignal.curve.calculateSignature(identity.privKey, signedPreKey.pubKey);
  return {
    registration_id: registrationId,
    identity: arrayBufferToBase64(identity.pubKey),
    signed_prekey: arrayBufferToBase64(signedPreKey.pubKey),
    signed_prekey_sig: arrayBufferToBase64(signature),
    one_time_prekey: arrayBufferToBase64(oneTimePreKey.pubKey),
  };
}

export { base64ToArrayBuffer, arrayBufferToBase64, padPlaintext, unpadPlaintext };
