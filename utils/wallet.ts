import type { UndefinedOr } from '@devprotocol/util-ts'
import { whenDefined } from '@devprotocol/util-ts'
import { JsonRpcProvider, Wallet, NonceManager } from 'ethers'

export const createWallet = ({
	rpcUrl,
}: {
	rpcUrl: string
}): UndefinedOr<NonceManager> => {
	const { MNEMONIC } = import.meta.env

	const provider = new JsonRpcProvider(rpcUrl)
	return whenDefined(
		MNEMONIC,
		(key) => new NonceManager(Wallet.fromPhrase(key, provider)),
	)
}
