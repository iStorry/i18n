import type {
  getMetadataStorage as GetMetadataStorage,
  ValidationArguments,
  ValidationError,
  ValidatorConstraintInterface,
} from 'class-validator';
import { createRequire } from 'node:module';
import { i18nStorage } from '../context/i18n.storage.js';
import type {
  I18nKey,
  I18nRegisteredTranslations,
} from '../interfaces/i18n-keys.interface.js';
import type {
  TranslateValidationErrorsOptions,
} from '../interfaces/validation-options.interface.js';
import { translateInContext } from '../context/translate.js';

const I18N_VALIDATION_MESSAGE = Symbol('I18N_VALIDATION_MESSAGE');

type I18nValidationMessage = ((args: ValidationArguments) => string) & {
  [I18N_VALIDATION_MESSAGE]: { key: string; args?: Record<string, unknown> };
};

/**
 * A class-validator `message` that translates `key` for the current locale:
 * `@Max(10, { message: i18nValidationMessage('orders.tooManyCopies') })`.
 * Placeholders: `{property}`, `{path}`, `{value}`, `{constraint1..n}` and
 * `{count}` (the first numeric constraint), plus `args`.
 */
export function i18nValidationMessage<T = I18nRegisteredTranslations>(
  key: I18nKey<NoInfer<T>>,
  args?: Record<string, unknown>,
): (validationArguments: ValidationArguments) => string {
  const message = (va: ValidationArguments) =>
    translateInContext(key as string, {
      args: { ...validationArgs(va.property, va.value, va.constraints), ...args },
    });

  return Object.assign(message, {
    [I18N_VALIDATION_MESSAGE]: { key: key as string, args },
  }) satisfies I18nValidationMessage;
}

/**
 * Interpolation args for a class-validator constraint, rendered the way
 * class-validator renders `$value` and `$constraint1`: `value` only when it's
 * a string, number or boolean, and array constraints joined with `, `.
 * `count` is the first numeric constraint (`@MinLength(3)` → 3), so plural
 * messages agree with it. `path` defaults to the property;
 * `translateValidationErrors` passes the full dotted path for nested objects.
 */
function validationArgs(
  property: string,
  value: unknown,
  constraints: unknown[] = [],
  path: string = property,
): Record<string, unknown> {
  const args: Record<string, unknown> = { property, path };
  if (['string', 'number', 'boolean'].includes(typeof value)) {
    args.value = value;
  }

  constraints.forEach((c, i) => (args[`constraint${i + 1}`] = constraintText(c)));
  const count = constraints.find((c) => typeof c === 'number');
  if (count !== undefined) {
    args.count = count;
  }
  return args;
}

/** class-validator's `constraintToString()`. */
function constraintText(constraint: unknown): string {
  if (Array.isArray(constraint)) {
    return constraint.join(', ');
  }
  if (typeof constraint === 'symbol') {
    return constraint.description ?? '';
  }
  return `${constraint}`;
}

interface MetadataLike {
  type: string;
  propertyName: string;
  constraints?: unknown[];
  constraintCls?: Function;
  message?: unknown;
}

type MetadataStorage = ReturnType<typeof GetMetadataStorage>;

const translatedConstraints = new WeakMap<ValidationError, Set<string>>();

/** True when `translateValidationErrors` localized this constraint. */
export function isTranslatedConstraint(error: ValidationError, constraint: string): boolean {
  return translatedConstraints.get(error)?.has(constraint) ?? false;
}

let classValidator: { getMetadataStorage: typeof GetMetadataStorage } | undefined;

/**
 * class-validator is an optional peer dependency: it's loaded when there are
 * errors to translate, which means it's installed, never when the package is
 * imported.
 */
function metadataStorage(): MetadataStorage {
  classValidator ??= createRequire(import.meta.url)('class-validator');
  return classValidator!.getMetadataStorage();
}

/**
 * Rewrites `error.constraints` in place for the current locale, for pipes of
 * your own. For every constraint whose decorator had no explicit `message`,
 * `validation.<name>` (e.g. `validation.isEmail`) is used when it exists;
 * messages from `i18nValidationMessage()` are re-translated with the full
 * `{path}`; plain custom strings are left alone. The decorator is found
 * through `error.target`, so errors without one (`validationError.target:
 * false`) are left as they are; `I18nValidationPipe` handles that option
 * itself. When a property has two decorators of one type (two `@Matches()`),
 * the one that failed is the one whose rendered message class-validator
 * stored; when that can't be told, its message is kept. Pass the `groups`,
 * `always`, `strictGroups` and `dismissDefaultMessages` you validated with.
 * Outside a request, errors are returned as they are.
 */
export function translateValidationErrors(
  errors: ValidationError[],
  options: TranslateValidationErrorsOptions = {},
): ValidationError[] {
  const store = i18nStorage.getStore();
  if (!store || !errors.length) {
    return errors;
  }
  const namespace = options.namespace ?? 'validation';
  const storage = metadataStorage();

  const visit = (error: ValidationError, parentPath?: string) => {
    const path = parentPath ? `${parentPath}.${error.property}` : error.property;
    if (error.constraints && error.target) {
      const metadatas = byConstraintName(error, storage, options);
      const translated = new Set<string>();
      for (const name of Object.keys(error.constraints)) {
        const candidates = metadatas.get(name) ?? [];
        const metadata =
          candidates.length > 1
            ? failedDecorator(error, error.constraints[name], candidates, storage, options)
            : candidates[0];
        if (candidates.length > 1 && !metadata) {
          continue; // can't tell which decorator failed: keep class-validator's message
        }
        const args = validationArgs(error.property, error.value, metadata?.constraints, path);
        const explicit = (metadata?.message as Partial<I18nValidationMessage> | undefined)?.[
          I18N_VALIDATION_MESSAGE
        ];

        if (explicit) {
          error.constraints[name] = store.service.translate(explicit.key, {
            locale: store.locale,
            args: { ...args, ...explicit.args },
          });
          translated.add(name);
          continue;
        }
        if (metadata?.message !== undefined) {
          continue; // plain custom message
        }

        const key = `${namespace}.${name}`;
        if (!store.service.exists(key, store.locale)) {
          continue;
        }
        error.constraints[name] = store.service.translate(key, { locale: store.locale, args });
        translated.add(name);
      }

      if (translated.size) {
        translatedConstraints.set(error, translated);
      }
    }

    error.children?.forEach((child) => visit(child, path));
  };

  errors.forEach((error) => visit(error));
  return errors;
}

function byConstraintName(
  error: ValidationError,
  storage: MetadataStorage,
  { groups, always = false, strictGroups = false }: TranslateValidationErrorsOptions,
): Map<string, MetadataLike[]> {
  const map = new Map<string, MetadataLike[]>();
  const ctor = error.target?.constructor;
  if (!ctor) {
    return map;
  }

  const metadatas = storage.getTargetValidationMetadatas(
    ctor, '', always, strictGroups, groups,
  ) as MetadataLike[];
  for (const m of metadatas) {
    if (m.propertyName !== error.property) {
      continue;
    }
    const custom = m.constraintCls
      ? storage.getTargetValidatorConstraints(m.constraintCls)[0]?.name
      : undefined;
    const name = custom ?? m.type;
    map.set(name, [...(map.get(name) ?? []), m]);
  }
  return map;
}

/**
 * class-validator keys `error.constraints` by name, so two decorators of one
 * type on a property (two `@Matches()`) share a key that holds the message of
 * the one that failed (the last one, when both did): the decorator whose
 * message renders to it. Undefined when none does, e.g. for a message
 * function that isn't pure.
 */
function failedDecorator(
  error: ValidationError,
  message: string,
  candidates: MetadataLike[],
  storage: MetadataStorage,
  { dismissDefaultMessages = false }: TranslateValidationErrorsOptions,
): MetadataLike | undefined {
  const target = error.target as object;
  return candidates.findLast((m) => {
    const va: ValidationArguments = {
      targetName: target.constructor?.name,
      property: error.property,
      object: target,
      value: error.value,
      constraints: m.constraints ?? [],
    };
    try {
      return renderMessage(m, va, storage, dismissDefaultMessages) === message;
    } catch {
      return false;
    }
  });
}

/** The message class-validator's `createValidationError()` builds for `m`. */
function renderMessage(
  m: MetadataLike,
  va: ValidationArguments,
  storage: MetadataStorage,
  dismissDefaultMessages: boolean,
): string | undefined {
  const store = i18nStorage.getStore()!;
  const explicit = (m.message as Partial<I18nValidationMessage> | undefined)?.[
    I18N_VALIDATION_MESSAGE
  ];
  // A key that doesn't exist would warn, or throw, for a decorator that passed.
  if (explicit && !store.service.exists(explicit.key, store.locale)) {
    return undefined;
  }

  let text: unknown = m.message;
  if (typeof text === 'function') {
    text = text(va);
  } else if (!text && !dismissDefaultMessages && m.constraintCls) {
    const instance = storage.getTargetValidatorConstraints(m.constraintCls)[0]?.instance as
      | ValidatorConstraintInterface
      | undefined;
    text = instance?.defaultMessage?.(va);
  }
  return typeof text === 'string' && text ? replaceMessageTokens(text, va) : '';
}

/**
 * class-validator's `ValidationUtils.replaceMessageSpecialTokens()` (0.14),
 * which it doesn't export. Keep the two in step: a message rendered
 * differently doesn't match, and keeps class-validator's text.
 */
function replaceMessageTokens(message: string, va: ValidationArguments): string {
  let text = message;
  va.constraints.forEach((c, i) => {
    text = text.replace(new RegExp(`\\$constraint${i + 1}`, 'g'), constraintText(c));
  });
  if (['string', 'boolean', 'number'].includes(typeof va.value)) {
    text = text.replace(/\$value/g, `${va.value}`);
  }
  return text.replace(/\$property/g, va.property).replace(/\$target/g, `${va.targetName}`);
}

/** Removes `target` from errors and their children, as class-validator does when it's off. */
export function withoutTargets(errors: ValidationError[]): ValidationError[] {
  for (const error of errors) {
    delete error.target;
    if (error.children) {
      withoutTargets(error.children);
    }
  }
  return errors;
}
