import {invoke as tauriInvoke} from '@tauri-apps/api/core';
import type {NativeCommand, NativeCommandMap} from '../../shared/generated/NativeCommandMap';

type CommandArgs<C extends NativeCommand> = NativeCommandMap[C]['args'];
export type NativeCommandResult<C extends NativeCommand> = NativeCommandMap[C]['result'] extends null
    ? void
    : NativeCommandMap[C]['result'];
type InvokeArgs<C extends NativeCommand> = CommandArgs<C> extends undefined
    ? []
    : [args: CommandArgs<C>];

/** Invoke a Rust-exported command with its generated argument/result contract. */
export function invokeNative<C extends NativeCommand>(
    command: C,
    ...args: InvokeArgs<C>
): Promise<NativeCommandResult<C>> {
    return invokeNativeWithArgs(command, args[0] as CommandArgs<C>);
}

/** Typed form for generic helpers that always carry an explicit args value. */
export function invokeNativeWithArgs<C extends NativeCommand>(
    command: C,
    args: CommandArgs<C>,
): Promise<NativeCommandResult<C>> {
    return tauriInvoke<NativeCommandResult<C>>(command, args);
}
