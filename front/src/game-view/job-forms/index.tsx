import * as React from 'react';
import styled from 'styled-components';
import { FormDesc } from '../defs';
import { I18n, TranslationFunction } from '../../i18n';

import { specialNamedTypes, specialContentTypes, toJobType } from './types';
import { makeGameMasterForm } from './gm';
import { makeMerchantForm } from './merchant';
import { makeWitchForm } from './witch';
import {
  OptionLabel,
  FormWrapper,
  JobFormsWrapper,
  FormName,
  FormContent,
  SelectWrapper,
} from './elements';

export interface IPropJobForms {
  forms: FormDesc[];
  onSubmit: (query: Record<string, string>) => void;
}

/**
 * All job forms currently open.
 */
export class JobForms extends React.PureComponent<IPropJobForms, {}> {
  public render() {
    const { forms, onSubmit } = this.props;
    return (
      <JobFormsWrapper>
        {forms.map((form, i) => (
          <Form key={`${i}-${form.type}`} form={form} onSubmit={onSubmit} />
        ))}
      </JobFormsWrapper>
    );
  }
}

export interface IPropForm {
  form: FormDesc;
  onSubmit: (query: Record<string, string>) => void;
}
/**
 * One job form.
 */
export class Form extends React.PureComponent<IPropForm, {}> {
  /**
   * Saved name of submit button.
   */
  protected commandName: string = '';
  public render() {
    const { form, onSubmit } = this.props;
    const { type, options } = form;
    return (
      <I18n namespace="game_client_form">
        {t => {
          // Make name of this form.
          const name = specialNamedTypes.includes(type)
            ? t(`specialName.${type}`)
            : t('normalName', {
                job: t(`roles:jobname.${type}`),
              });

          const content = specialContentTypes.includes(type)
            ? // This is special!
              makeSpecialContent(form, t)
            : makeNormalContent(form, t);

          // Handle submission of job form.
          const handleSubmit = (e: React.SyntheticEvent<HTMLFormElement>) => {
            e.preventDefault();
            const form = e.currentTarget;
            // Retrieve a key/value pairs of the form.
            const data = new FormData(form);
            // Make a plain object from it.
            const query: Record<string, string> = {};
            for (const [key, value] of data.entries()) {
              // value is either string or File.
              // File should not occur here.
              if ('string' === typeof value) {
                query[key] = value;
              } else {
                console.warn('File', value);
              }
            }
            // add special parameters
            if (this.commandName !== '') {
              query.commandname = this.commandName;
            }
            query.jobtype = toJobType(type);
            // query is generated
            console.log(query);
            onSubmit(query);
          };
          // Handle click of something.
          const handleClick = (e: React.SyntheticEvent<HTMLFormElement>) => {
            const t = e.target as HTMLInputElement;
            // When submit button is clicked, save its name,
            if (t.tagName === 'INPUT' && t.type === 'submit') {
              this.commandName = t.name;
            }
          };

          return (
            <FormWrapper>
              <form onSubmit={handleSubmit} onClick={handleClick}>
                <FormName>{name}</FormName>
                <FormContent>
                  {content}
                  <SelectWrapper>
                    <input
                      type="submit"
                      value={t('game_client_form:normalButton')}
                    />
                  </SelectWrapper>
                </FormContent>
              </form>
            </FormWrapper>
          );
        }}
      </I18n>
    );
  }
}

/**
 * Make a normal content for job form.
 */
function makeNormalContent(
  { type, options }: FormDesc,
  t: TranslationFunction,
) {
  // List up options.
  const opts = options.map(({ name, value }, i) => (
    <OptionLabel key={`${i}-value`}>
      {name}
      <input type="radio" name="target" value={value} />
    </OptionLabel>
  ));
  return (
    <>
      <p>{t(`game_client_form:messages.${type}`)}</p>
      <p>{opts}</p>
    </>
  );
}

/**
 * Make special content of job form.
 */
function makeSpecialContent(form: FormDesc, t: TranslationFunction) {
  switch (form.type) {
    case 'GameMaster': {
      return makeGameMasterForm(form, t);
    }
    case 'Merchant': {
      return makeMerchantForm(form, t);
    }
    case 'Witch': {
      return makeWitchForm(form, t);
    }
    default: {
      console.error(`Special form for ${form.type} is undefined`);
      return null;
    }
  }
}
