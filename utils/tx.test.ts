import { expect, describe, it, vi } from 'vitest'
import { send } from './tx'
import redis, { createClient } from 'redis'
import {
	Contract,
	JsonRpcProvider,
	Wallet,
	type TransactionRequest,
} from 'ethers'
import { generateTransactionKey } from './db'
import { agentAddresses } from '@devprotocol/dev-kit'

enum MockUses {
	Default = 'default',
	Error = 'error',
}
const redisData = new Map()
const redisConnectUses: MockUses = MockUses.Default

vi.mock('redis', async () => {
	const actual: typeof redis = await vi.importActual('redis')
	const lib = vi.fn(() => ({
		connect: vi.fn(() => {
			if (redisConnectUses === MockUses.Default) {
				return null
			}
			if (redisConnectUses === MockUses.Error) {
				throw new Error('REDIS ERROR')
			}
		}),
		get: vi.fn(async (k) => redisData.get(k)),
		set: vi.fn(async (k, v) => redisData.set(k, v)),
		quit: vi.fn(),
	}))

	return { ...actual, default: actual, createClient: lib }
})
vi.mock('JsonRpcProvider', () => {
	return class {
		public async getFeeData() {
			return { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }
		}
	}
})

describe('send', () => {
	describe('Normal cases', () => {
		const redis = createClient()
		const provider = new JsonRpcProvider(
			'https://polygon-mumbai-bor-rpc.publicnode.com',
		)
		const signer = Wallet.createRandom().connect(provider)
		vi.spyOn(signer, 'sendTransaction').mockImplementation(
			async (tx: TransactionRequest) => {
				return ['sent', tx] as any
			},
		)

		it('should return tx', async () => {
			const contract = new Contract(
				agentAddresses.polygon.mumbai.weth,
				['function transfer(address, uint) public'],
				signer,
			)

			const { to, data } = await contract.transfer.populateTransaction(
				signer.address,
				0n,
			)
			redisData.set(
				generateTransactionKey(to, data, 'id'),
				new Date().getTime() - 60001,
			)
			const res = await send({
				contract,
				method: 'transfer',
				signer,
				chainId: 80001,
				rpcUrl: 'https://polygon-mumbai-bor-rpc.publicnode.com/', // Mumbai
				args: [signer.address, 0n],
				requestId: 'id',
				redis,
			})
			console.log(res)
			expect((res as any)[0]).toBe('sent')
		})
	})
})
