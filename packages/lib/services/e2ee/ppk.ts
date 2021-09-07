import * as NodeRSA from 'node-rsa';
import uuid from '../../uuid';
import { getActiveMasterKey, saveLocalSyncInfo, SyncInfo } from '../synchronizer/syncInfoUtils';
import EncryptionService, { EncryptionCustomHandler, EncryptionMethod } from './EncryptionService';
import { MasterKeyEntity } from './types';
import { getMasterPassword } from './utils';

interface PrivateKey {
	encryptionMethod: EncryptionMethod;
	ciphertext: string;
}

export type PublicKey = string;

export interface PublicPrivateKeyPair {
	id: string;
	publicKey: PublicKey;
	privateKey: PrivateKey;
	createdTime: number;
}

async function encryptPrivateKey(encryptionService: EncryptionService, password: string, plainText: string): Promise<PrivateKey> {
	return {
		encryptionMethod: EncryptionMethod.SJCL4,
		ciphertext: await encryptionService.encrypt(EncryptionMethod.SJCL4, password, plainText),
	};
}

export async function decryptPrivateKey(encryptionService: EncryptionService, encryptedKey: PrivateKey, password: string): Promise<string> {
	return encryptionService.decrypt(encryptedKey.encryptionMethod, password, encryptedKey.ciphertext);
}

const nodeRSAEncryptionScheme = 'pkcs1_oaep';

function nodeRSAOptions(): NodeRSA.Options {
	return {
		encryptionScheme: nodeRSAEncryptionScheme,
	};
}

export async function generateKeyPair(encryptionService: EncryptionService, password: string): Promise<PublicPrivateKeyPair> {
	const keys = new NodeRSA();
	keys.setOptions(nodeRSAOptions());
	keys.generateKeyPair(2048, 65537);

	// Sanity check
	if (!keys.isPrivate()) throw new Error('No private key was generated');
	if (!keys.isPublic()) throw new Error('No public key was generated');

	return {
		id: uuid.createNano(),
		privateKey: await encryptPrivateKey(encryptionService, password, keys.exportKey('pkcs1-private-pem')),
		publicKey: keys.exportKey('pkcs1-public-pem'),
		createdTime: Date.now(),
	};
}

export async function generateKeyPairAndSave(encryptionService: EncryptionService, localInfo: SyncInfo, password: string): Promise<PublicPrivateKeyPair> {
	localInfo.ppk = await generateKeyPair(encryptionService, password);
	saveLocalSyncInfo(localInfo);
	return localInfo.ppk;
}

export async function setPpkIfNotExist(service: EncryptionService, localInfo: SyncInfo, remoteInfo: SyncInfo) {
	if (localInfo.ppk || remoteInfo.ppk) return;

	const masterKey = getActiveMasterKey(localInfo);
	if (!masterKey) return;

	const password = getMasterPassword(false);
	if (!password) return;

	await generateKeyPairAndSave(service, localInfo, getMasterPassword());
}

export async function ppkPasswordIsValid(service: EncryptionService, ppk: PublicPrivateKeyPair, password: string):Promise<boolean> {
	if (!ppk) throw new Error('PPK is undefined');

	try {
		await loadPpk(service, ppk, password);
	} catch (error) {
		return false;
	}

	return true;
}

async function loadPpk(service: EncryptionService, ppk: PublicPrivateKeyPair, password: string): Promise<NodeRSA> {
	const keys = new NodeRSA();
	keys.setOptions(nodeRSAOptions());
	keys.importKey(ppk.publicKey, 'pkcs1-public-pem');
	keys.importKey(await decryptPrivateKey(service, ppk.privateKey, password), 'pkcs1-private-pem');
	return keys;
}

async function loadPublicKey(publicKey: PublicKey): Promise<NodeRSA> {
	const keys = new NodeRSA();
	keys.setOptions(nodeRSAOptions());
	keys.importKey(publicKey, 'pkcs1-public-pem');
	return keys;
}

export function ppkEncryptionHandler(ppkId: string, nodeRSA: NodeRSA): EncryptionCustomHandler {
	interface Context {
		nodeRSA: NodeRSA;
		ppkId: string;
	}

	return {
		context: {
			nodeRSA,
			ppkId,
		},
		encrypt: async (context: Context, hexaBytes: string, _password: string): Promise<string> => {
			return JSON.stringify({
				ppkId: context.ppkId,
				scheme: nodeRSAEncryptionScheme,
				ciphertext: context.nodeRSA.encrypt(hexaBytes, 'hex'),
			});
		},
		decrypt: async (context: Context, ciphertext: string, _password: string): Promise<string> => {
			const parsed = JSON.parse(ciphertext);
			if (parsed.ppkId !== context.ppkId) throw new Error(`Needs private key ${parsed.ppkId} to decrypt, but using ${context.ppkId}`);
			return context.nodeRSA.decrypt(Buffer.from(parsed.ciphertext, 'hex'), 'utf8');
		},
	};
}

// Generates a master key and encrypts it using the provided PPK
export async function ppkGenerateMasterKey(service: EncryptionService, ppk: PublicPrivateKeyPair, password: string): Promise<MasterKeyEntity> {
	const nodeRSA = await loadPpk(service, ppk, password);
	const handler = ppkEncryptionHandler(ppk.id, nodeRSA);

	return service.generateMasterKey('', {
		encryptionMethod: EncryptionMethod.Custom,
		encryptionHandler: handler,
	});
}

// Decrypt the content of a master key that was encrypted using ppkGenerateMasterKey()
export async function ppkDecryptMasterKeyContent(service: EncryptionService, masterKey: MasterKeyEntity, ppk: PublicPrivateKeyPair, password: string): Promise<string> {
	const nodeRSA = await loadPpk(service, ppk, password);
	const handler = ppkEncryptionHandler(ppk.id, nodeRSA);

	return service.decryptMasterKeyContent(masterKey, '', {
		encryptionHandler: handler,
	});
}

export async function reencryptFromPasswordToPublicKey(service: EncryptionService, masterKey: MasterKeyEntity, decryptionPassword: string, encryptionPublicKey: PublicPrivateKeyPair): Promise<MasterKeyEntity> {
	const encryptionHandler = ppkEncryptionHandler(encryptionPublicKey.id, await loadPublicKey(encryptionPublicKey.publicKey));

	const plainText = await service.decryptMasterKeyContent(masterKey, decryptionPassword);
	const newContent = await service.encryptMasterKeyContent(EncryptionMethod.Custom, plainText, '', { encryptionHandler });

	return { ...masterKey, ...newContent };
}

export async function reencryptFromPublicKeyToPassword(service: EncryptionService, masterKey: MasterKeyEntity, decryptionPpk: PublicPrivateKeyPair, decryptionPassword: string, encryptionPassword: string): Promise<MasterKeyEntity> {
	const decryptionHandler = ppkEncryptionHandler(decryptionPpk.id, await loadPpk(service, decryptionPpk, decryptionPassword));

	const plainText = await service.decryptMasterKeyContent(masterKey, '', { encryptionHandler: decryptionHandler });
	const newContent = await service.encryptMasterKeyContent(null, plainText, encryptionPassword);

	return { ...masterKey, ...newContent };
}


export async function ppkReencryptMasterKey(service: EncryptionService, masterKey: MasterKeyEntity, decryptionPpk: PublicPrivateKeyPair, decryptionPassword: string, encryptionPublicKey: PublicPrivateKeyPair): Promise<MasterKeyEntity> {
	const encryptionHandler = ppkEncryptionHandler(encryptionPublicKey.id, await loadPublicKey(encryptionPublicKey.publicKey));
	const decryptionHandler = ppkEncryptionHandler(decryptionPpk.id, await loadPpk(service, decryptionPpk, decryptionPassword));

	return service.reencryptMasterKey(masterKey, '', {
		encryptionHandler: decryptionHandler,
	}, {
		encryptionHandler: encryptionHandler,
	});
}